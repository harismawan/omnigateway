//! Verified TLS using the workspace's existing rustls stack; no insecure
//! verifier and no new connector dependency. URL sslmode negotiation stays in
//! tokio-postgres; all TLS connections verify native/configured trust roots.
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_postgres::tls::{ChannelBinding, MakeTlsConnect, TlsConnect, TlsStream};

#[derive(Clone)]
pub(super) struct Connector(Arc<rustls::ClientConfig>);

impl Connector {
    pub(super) fn new() -> Self {
        let mut roots = rustls::RootCertStore::empty();
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            let _result = roots.add(cert);
        }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("supported TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        Self(Arc::new(config))
    }
}

pub(super) struct Handshake {
    connector: tokio_rustls::TlsConnector,
    name: rustls::pki_types::ServerName<'static>,
}

pub(super) struct Stream<S>(tokio_rustls::client::TlsStream<S>);

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> MakeTlsConnect<S> for Connector {
    type Stream = Stream<S>;
    type TlsConnect = Handshake;
    type Error = io::Error;
    fn make_tls_connect(&mut self, domain: &str) -> Result<Handshake, io::Error> {
        let name = rustls::pki_types::ServerName::try_from(domain.to_owned())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid PG TLS hostname"))?;
        Ok(Handshake {
            connector: self.0.clone().into(),
            name,
        })
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> TlsConnect<S> for Handshake {
    type Stream = Stream<S>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Stream<S>, io::Error>> + Send>>;
    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move { self.connector.connect(self.name, stream).await.map(Stream) })
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for Stream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Stream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin> TlsStream for Stream<S> {
    fn channel_binding(&self) -> ChannelBinding {
        ChannelBinding::none()
    }
}
