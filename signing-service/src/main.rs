//! ETO FROST Signing Service
//!
//! Minimal binary that:
//! 1. Manages FROST key shares (2-of-3 threshold)
//! 2. Coordinates signing rounds
//! 3. Returns combined Ed25519 signatures
//!
//! Attack surface: HTTP endpoint (mTLS in production)

mod frost;
mod keystore;
mod service;

use std::net::SocketAddr;
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main]
async fn main() {
    fmt().with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap())).init();

    let addr: SocketAddr = std::env::var("SIGNING_SERVICE_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:9100".to_string())
        .parse()
        .expect("invalid SIGNING_SERVICE_ADDR");

    tracing::info!("Starting ETO signing service on {}", addr);

    let keystore = keystore::KeyStore::new();
    let service = service::SigningService::new(keystore);

    service::run_server(service, addr).await;
}
