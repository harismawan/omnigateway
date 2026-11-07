//! Error codes, retryability and the client status map, mirroring
//! `packages/ir/src/errors.ts`.

use std::fmt;

/// Every way a request can fail, named once. Closed on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    Auth,
    RateLimit,
    QuotaExhausted,
    Overloaded,
    BadRequest,
    Conflict,
    ContentFilter,
    CapabilityMismatch,
    ModelUnavailable,
    FingerprintRefused,
    Upstream,
    Timeout,
    Network,
    NoCandidates,
    AllCandidatesFailed,
    Internal,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 16] = [
        ErrorCode::Auth,
        ErrorCode::RateLimit,
        ErrorCode::QuotaExhausted,
        ErrorCode::Overloaded,
        ErrorCode::BadRequest,
        ErrorCode::Conflict,
        ErrorCode::ContentFilter,
        ErrorCode::CapabilityMismatch,
        ErrorCode::ModelUnavailable,
        ErrorCode::FingerprintRefused,
        ErrorCode::Upstream,
        ErrorCode::Timeout,
        ErrorCode::Network,
        ErrorCode::NoCandidates,
        ErrorCode::AllCandidatesFailed,
        ErrorCode::Internal,
    ];

    /// The TS spelling, which is also what `request_logs.error_code` stores.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Auth => "AUTH",
            ErrorCode::RateLimit => "RATE_LIMIT",
            ErrorCode::QuotaExhausted => "QUOTA_EXHAUSTED",
            ErrorCode::Overloaded => "OVERLOADED",
            ErrorCode::BadRequest => "BAD_REQUEST",
            ErrorCode::Conflict => "CONFLICT",
            ErrorCode::ContentFilter => "CONTENT_FILTER",
            ErrorCode::CapabilityMismatch => "CAPABILITY_MISMATCH",
            ErrorCode::ModelUnavailable => "MODEL_UNAVAILABLE",
            ErrorCode::FingerprintRefused => "FINGERPRINT_REFUSED",
            ErrorCode::Upstream => "UPSTREAM",
            ErrorCode::Timeout => "TIMEOUT",
            ErrorCode::Network => "NETWORK",
            ErrorCode::NoCandidates => "NO_CANDIDATES",
            ErrorCode::AllCandidatesFailed => "ALL_CANDIDATES_FAILED",
            ErrorCode::Internal => "INTERNAL",
        }
    }

    pub fn parse(s: &str) -> Option<ErrorCode> {
        ErrorCode::ALL.into_iter().find(|c| c.as_str() == s)
    }

    /// `RETRYABLE[code]`: whether dispatch should advance to the next candidate.
    pub fn retryable(self) -> bool {
        match self {
            ErrorCode::Auth
            | ErrorCode::RateLimit
            | ErrorCode::QuotaExhausted
            | ErrorCode::Overloaded
            | ErrorCode::ModelUnavailable
            | ErrorCode::CapabilityMismatch
            | ErrorCode::Upstream
            | ErrorCode::Timeout
            | ErrorCode::Network => true,
            ErrorCode::BadRequest
            | ErrorCode::Conflict
            | ErrorCode::ContentFilter
            | ErrorCode::FingerprintRefused
            | ErrorCode::NoCandidates
            | ErrorCode::AllCandidatesFailed
            | ErrorCode::Internal => false,
        }
    }

    /// `HTTP_STATUS[code]`: the status the client sees.
    pub fn http_status(self) -> u16 {
        match self {
            ErrorCode::Auth => 401,
            ErrorCode::RateLimit | ErrorCode::QuotaExhausted => 429,
            ErrorCode::Overloaded => 503,
            ErrorCode::BadRequest
            | ErrorCode::ContentFilter
            | ErrorCode::CapabilityMismatch
            | ErrorCode::FingerprintRefused => 400,
            ErrorCode::Conflict => 409,
            ErrorCode::ModelUnavailable => 404,
            ErrorCode::Upstream | ErrorCode::Network => 502,
            ErrorCode::Timeout => 504,
            ErrorCode::NoCandidates | ErrorCode::AllCandidatesFailed => 503,
            ErrorCode::Internal => 500,
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `GatewayError`. `retryable` is derived from the code, as in TS.
///
/// `gateway_authored` is opt-in and defaults false: set it only for a message
/// built from literals and values this repository owns.
#[derive(Debug, Clone, PartialEq)]
pub struct GatewayError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    /// Which upstream failed, when the failure came from one.
    pub provider: Option<String>,
    /// The upstream's own HTTP status, kept for logs.
    pub upstream_status: Option<u16>,
    pub gateway_authored: bool,
    /// Milliseconds, from `Retry-After`. A JS number, so possibly fractional.
    pub retry_after_ms: Option<f64>,
    /// Capability reductions the failed attempt had applied.
    pub degradations: Vec<String>,
}

impl GatewayError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        GatewayError {
            code,
            message: message.into(),
            retryable: code.retryable(),
            provider: None,
            upstream_status: None,
            gateway_authored: false,
            retry_after_ms: None,
            degradations: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = Some(provider.into());
        self
    }

    #[must_use]
    pub fn with_status(mut self, status: u16) -> Self {
        self.upstream_status = Some(status);
        self
    }

    #[must_use]
    pub fn gateway_authored(mut self) -> Self {
        self.gateway_authored = true;
        self
    }

    #[must_use]
    pub fn with_retry_after_ms(mut self, ms: Option<f64>) -> Self {
        self.retry_after_ms = ms;
        self
    }

    #[must_use]
    pub fn with_degradations(mut self, degradations: Vec<String>) -> Self {
        self.degradations = degradations;
        self
    }
}

impl fmt::Display for GatewayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for GatewayError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_and_status_tables_match_ts() {
        let retryable: Vec<&str> = ErrorCode::ALL
            .into_iter()
            .filter(|c| c.retryable())
            .map(ErrorCode::as_str)
            .collect();
        assert_eq!(
            retryable,
            [
                "AUTH",
                "RATE_LIMIT",
                "QUOTA_EXHAUSTED",
                "OVERLOADED",
                "CAPABILITY_MISMATCH",
                "MODEL_UNAVAILABLE",
                "UPSTREAM",
                "TIMEOUT",
                "NETWORK"
            ]
        );
        let status: Vec<(&str, u16)> = ErrorCode::ALL
            .into_iter()
            .map(|c| (c.as_str(), c.http_status()))
            .collect();
        assert_eq!(
            status,
            [
                ("AUTH", 401),
                ("RATE_LIMIT", 429),
                ("QUOTA_EXHAUSTED", 429),
                ("OVERLOADED", 503),
                ("BAD_REQUEST", 400),
                ("CONFLICT", 409),
                ("CONTENT_FILTER", 400),
                ("CAPABILITY_MISMATCH", 400),
                ("MODEL_UNAVAILABLE", 404),
                ("FINGERPRINT_REFUSED", 400),
                ("UPSTREAM", 502),
                ("TIMEOUT", 504),
                ("NETWORK", 502),
                ("NO_CANDIDATES", 503),
                ("ALL_CANDIDATES_FAILED", 503),
                ("INTERNAL", 500),
            ]
        );
        for code in ErrorCode::ALL {
            assert_eq!(ErrorCode::parse(code.as_str()), Some(code));
        }
    }

    #[test]
    fn new_error_derives_retryable_and_defaults_unauthored() {
        let e = GatewayError::new(ErrorCode::BadRequest, "x");
        assert!(!e.retryable);
        assert!(!e.gateway_authored);
        assert!(e.degradations.is_empty());
        assert!(GatewayError::new(ErrorCode::Auth, "x").retryable);
    }
}
