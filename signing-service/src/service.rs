//! HTTP JSON API for the signing service
//!
//! Endpoints:
//! POST /dkg          — Generate new key shares
//! POST /sign         — Sign a message with 2 shares
//! GET  /keys         — List keys
//! GET  /keys/:id     — Get key info
//! DELETE /keys/:id   — Revoke key
//! GET  /audit        — Get audit log
//! GET  /health       — Health check

use crate::frost;
use crate::keystore::KeyStore;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct SigningService {
    keystore: Arc<KeyStore>,
}

impl SigningService {
    pub fn new(keystore: KeyStore) -> Self {
        Self { keystore: Arc::new(keystore) }
    }
}

pub async fn run_server(service: SigningService, addr: SocketAddr) {
    let listener = TcpListener::bind(addr).await.expect("Failed to bind");
    let keystore = service.keystore;

    loop {
        let (mut stream, _) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => { tracing::error!("Accept error: {}", e); continue; }
        };

        let ks = keystore.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            let n = match stream.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => return,
            };

            let request = String::from_utf8_lossy(&buf[..n]);
            let (method, path, body) = parse_http_request(&request);

            let (status, response_body) = handle_request(&ks, &method, &path, &body);

            let response = format!(
                "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
                status, response_body.len(), response_body
            );

            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

fn handle_request(ks: &KeyStore, method: &str, path: &str, body: &str) -> (u16, String) {
    match (method, path) {
        ("GET", "/health") => (200, r#"{"status":"ok"}"#.to_string()),

        ("POST", "/dkg") => {
            let dkg = frost::generate_shares(2, 3);
            ks.store_dkg_result(&dkg);

            let response = serde_json::json!({
                "key_id": dkg.key_id,
                "public_key": bs58::encode(&dkg.public_key).into_string(),
                "public_key_hex": hex::encode(&dkg.public_key),
                "shares": dkg.shares.iter().map(|s| serde_json::json!({
                    "share_index": s.share_index,
                    "share_hex": hex::encode(&s.share_bytes),
                })).collect::<Vec<_>>(),
            });
            (200, response.to_string())
        }

        ("POST", "/sign") => {
            #[derive(serde::Deserialize)]
            struct SignRequest {
                key_id: String,
                message_hex: String,
                share_indices: [u8; 2],
            }

            let req: SignRequest = match serde_json::from_str(body) {
                Ok(r) => r,
                Err(e) => return (400, format!(r#"{{"error":"Invalid request: {}"}}"#, e)),
            };

            let message = match hex::decode(&req.message_hex) {
                Ok(m) => m,
                Err(_) => return (400, r#"{"error":"Invalid hex in message_hex"}"#.to_string()),
            };

            let shares = match ks.get_shares_for_signing(&req.key_id, &req.share_indices) {
                Some(s) => s,
                None => return (404, r#"{"error":"Key not found or missing shares"}"#.to_string()),
            };

            match frost::sign_with_shares(&shares, &message) {
                Ok(sig) => {
                    use sha2::{Sha256, Digest};
                    let msg_hash = hex::encode(Sha256::digest(&message));
                    ks.record_sign(&req.key_id, &req.share_indices, true, &msg_hash);

                    let response = serde_json::json!({
                        "signature": hex::encode(sig.to_bytes()),
                        "public_key": bs58::encode(&shares[0].public_key).into_string(),
                        "key_id": req.key_id,
                    });
                    (200, response.to_string())
                }
                Err(e) => {
                    ks.record_sign(&req.key_id, &req.share_indices, false, "");
                    (500, format!(r#"{{"error":"Signing failed: {}"}}"#, e))
                }
            }
        }

        ("GET", path) if path.starts_with("/keys/") => {
            let key_id = &path[6..];
            match ks.get_public_key(key_id) {
                Some(pk) => {
                    let response = serde_json::json!({
                        "key_id": key_id,
                        "public_key": bs58::encode(&pk).into_string(),
                        "public_key_hex": hex::encode(&pk),
                    });
                    (200, response.to_string())
                }
                None => (404, r#"{"error":"Key not found"}"#.to_string()),
            }
        }

        ("GET", "/keys") => {
            let keys = ks.list_keys();
            (200, serde_json::to_string(&keys).unwrap_or_default())
        }

        ("DELETE", path) if path.starts_with("/keys/") => {
            let key_id = &path[6..];
            if ks.revoke_key(key_id) {
                (200, r#"{"status":"revoked"}"#.to_string())
            } else {
                (404, r#"{"error":"Key not found"}"#.to_string())
            }
        }

        ("GET", "/audit") => {
            let log = ks.get_audit_log(None, 100);
            (200, serde_json::to_string(&log).unwrap_or_default())
        }

        _ => (404, r#"{"error":"Not found"}"#.to_string()),
    }
}

fn parse_http_request(raw: &str) -> (String, String, String) {
    let mut lines = raw.lines();
    let first_line = lines.next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let method = parts.first().unwrap_or(&"GET").to_string();
    let path = parts.get(1).unwrap_or(&"/").to_string();

    // Find body after empty line
    let body = if let Some(pos) = raw.find("\r\n\r\n") {
        raw[pos + 4..].to_string()
    } else if let Some(pos) = raw.find("\n\n") {
        raw[pos + 2..].to_string()
    } else {
        String::new()
    };

    (method, path, body)
}
