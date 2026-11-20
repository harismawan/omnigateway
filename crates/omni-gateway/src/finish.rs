//! The one place a request's row is completed (`finishLog`'s two call sites
//! in `routes/proxy.ts`: the success path and the terminal catch).
//!
//! A [`Finisher`] is created when the request arrives and sends exactly one
//! [`LogEvent::Finish`]. If it is dropped without having sent one — the client
//! hung up and the response future or body was dropped — it sends the 499
//! row itself. That is the structural cancellation the spec asks for: no task
//! is left behind to notice the disconnect.

use std::sync::{Arc, Mutex, PoisonError};

use omni_gateway_core::ratelimit::Admission;
use omni_ir::error::GatewayError;
use omni_store::writer::{FinishSlot, RequestLog, WriterHandle};

use crate::dispatch::report_rejection;

/// Where in the request the finisher stands, which decides what a hang-up
/// records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Before the response is handed back: a hang-up lands in TS's catch,
    /// which always files 499.
    Handler,
    /// A stream whose head went out: a hang-up files 499 only where nothing
    /// assigned a status.
    Streaming,
}

pub struct Finisher {
    pub capture: Option<crate::body_capture::CaptureCompletion>,
    writer: WriterHandle,
    pub slot: Option<FinishSlot>,
    /// `telemetry.record` after the row is handed to the writer.
    telemetry: Option<Arc<crate::telemetry::Telemetry>>,
    request_id: String,
    started_at: i64,
    surface: &'static str,
    now: fn() -> i64,
    pub key_id: Option<String>,
    pub requested_model: String,
    /// The requested model held a lone surrogate: `requested_model` is its
    /// lossy form, so the completion must not debit that name's subject.
    pub model_unencodable: bool,
    /// Dispatch's own log, once the request got that far.
    pub outcome: Option<Arc<Mutex<RequestLog>>>,
    /// The concurrency slot; freed just before the row is written.
    pub admission: Option<Admission>,
    phase: Phase,
    done: bool,
}

impl std::fmt::Debug for Finisher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Finisher")
            .field("request_id", &self.request_id)
            .field("done", &self.done)
            .finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Finisher {
    pub fn new(
        writer: WriterHandle,
        request_id: String,
        started_at: i64,
        surface: &'static str,
        now: fn() -> i64,
    ) -> Self {
        Self {
            capture: None,
            writer,
            slot: None,
            telemetry: None,
            request_id,
            started_at,
            surface,
            now,
            key_id: None,
            requested_model: String::new(),
            model_unencodable: false,
            outcome: None,
            admission: None,
            phase: Phase::Handler,
            done: false,
        }
    }

    /// Records each completed request in `telemetry` (`finishLog`'s
    /// `telemetry?.record`).
    #[must_use]
    pub fn with_telemetry(mut self, telemetry: Arc<crate::telemetry::Telemetry>) -> Self {
        self.telemetry = Some(telemetry);
        self
    }

    /// Hands this finisher's duty to the returned one, leaving this one
    /// inert: a stream's body owns the row from here on.
    pub fn take(&mut self) -> Finisher {
        let mut moved = Finisher::new(
            self.writer.clone(),
            self.request_id.clone(),
            self.started_at,
            self.surface,
            self.now,
        );
        moved.telemetry = self.telemetry.clone();
        std::mem::swap(self, &mut moved);
        self.done = true;
        moved
    }

    pub fn streaming(&mut self) {
        self.phase = Phase::Streaming;
    }

    /// `outcome?.log() ?? newCompletedRequestLog(...)`.
    fn current(&self) -> RequestLog {
        match &self.outcome {
            Some(log) => lock(log).clone(),
            None => {
                let mut l = RequestLog::new(self.request_id.clone(), self.started_at, 0);
                l.requested_model = self.requested_model.clone();
                l
            }
        }
    }

    fn write(&mut self, mut log: RequestLog) {
        self.done = true;
        if let Some(mut a) = self.admission.take() {
            a.release();
        }
        log.api_key_id = self.key_id.clone();
        log.model_unencodable = self.model_unencodable;
        // PG acquired its terminal credit before admission, including for
        // this destructor path. There is no capacity wait with a slot held.
        // Telemetry is recorded whether or not the writer took the row, as
        // TS records after an append that may have failed.
        if let Some(t) = &self.telemetry {
            t.record(&log);
        }
        if let Some(capture) = self.capture.take() {
            if self.phase == Phase::Streaming {
                capture.collector.response(omni_ir::jsjson::JsValue::Array(
                    capture
                        .sink
                        .frames
                        .iter()
                        .map(|s| omni_ir::jsjson::JsValue::String(s.encode_utf16().collect()))
                        .collect(),
                ));
            }
            let writer = self.writer.clone();
            self.writer.finish(self.slot.take(), log.clone());
            self.writer.completion_callback(async move {
                writer.after_completions().await;
                capture.persist(&log).await;
            });
        } else {
            self.writer.finish(self.slot.take(), log);
        }
    }

    /// The success path's `log(cancelled, failure)`: dispatch's log as it
    /// stands, with a status filled in only where nothing assigned one.
    pub fn complete(&mut self, cancelled: bool, failure: Option<&GatewayError>) {
        if self.done {
            return;
        }
        let mut log = self.current();
        if cancelled && log.status == 0 {
            log.status = 499;
            log.error_code = Some("interrupted".into());
            log.duration_ms = (self.now)() - self.started_at;
        } else if let (false, Some(e)) = (cancelled, failure) {
            if log.status == 0 {
                log.status = i64::from(e.code.http_status());
                log.error_code = Some(e.code.as_str().into());
                log.duration_ms = (self.now)() - self.started_at;
            }
            report_rejection(&log, e, Some(self.surface));
        }
        self.write(log);
    }

    /// The terminal catch: the error decides the status. Skipped where the
    /// row was already completed.
    pub fn reject(&mut self, e: &GatewayError) {
        if self.done {
            return;
        }
        let mut log = self.current();
        log.status = i64::from(e.code.http_status());
        log.error_code = Some(e.code.as_str().into());
        log.duration_ms = (self.now)() - self.started_at;
        report_rejection(&log, e, Some(self.surface));
        self.write(log);
    }

    fn cancelled(&mut self) {
        if let Some(capture) = &self.capture {
            capture.collector.truncated();
        }
        match self.phase {
            Phase::Streaming => self.complete(true, None),
            Phase::Handler => {
                let mut log = self.current();
                log.status = 499;
                log.error_code = Some("interrupted".into());
                log.duration_ms = (self.now)() - self.started_at;
                self.write(log);
            }
        }
    }
}

impl Drop for Finisher {
    fn drop(&mut self) {
        if !self.done {
            self.cancelled();
        }
    }
}
