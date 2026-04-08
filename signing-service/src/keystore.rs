//! Key share storage
//!
//! Phase 3: In-memory storage
//! Phase 3.5: CloudHSM PKCS#11

use crate::frost::{KeyShare, DkgResult};
use std::collections::HashMap;
use std::sync::RwLock;

pub struct KeyStore {
    /// key_id → (public_key, shares held by this service)
    keys: RwLock<HashMap<String, StoredKey>>,
    /// Audit log of all signing operations
    audit_log: RwLock<Vec<AuditEntry>>,
}

struct StoredKey {
    pub public_key: [u8; 32],
    /// Which shares this service holds (typically share 2 = "HSM share")
    pub shares: Vec<KeyShare>,
    pub created_at: std::time::SystemTime,
    pub sign_count: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct AuditEntry {
    pub timestamp: String,
    pub key_id: String,
    pub operation: String,    // "sign" | "dkg" | "rotate" | "revoke"
    pub success: bool,
    pub shares_used: Vec<u8>, // indices of shares used
    pub message_hash: String, // SHA256 of signed message (not the message itself)
}

impl KeyStore {
    pub fn new() -> Self {
        Self {
            keys: RwLock::new(HashMap::new()),
            audit_log: RwLock::new(Vec::new()),
        }
    }

    /// Store a DKG result (all shares for dev mode, or just the service's share in production)
    pub fn store_dkg_result(&self, dkg: &DkgResult) {
        let mut keys = self.keys.write().unwrap();
        keys.insert(dkg.key_id.clone(), StoredKey {
            public_key: dkg.public_key,
            shares: dkg.shares.clone(),
            created_at: std::time::SystemTime::now(),
            sign_count: 0,
        });
        self.log_audit(&dkg.key_id, "dkg", true, &[]);
    }

    /// Get the public key for a key ID
    pub fn get_public_key(&self, key_id: &str) -> Option<[u8; 32]> {
        self.keys.read().unwrap().get(key_id).map(|k| k.public_key)
    }

    /// Get shares for signing (returns 2 shares)
    pub fn get_shares_for_signing(&self, key_id: &str, share_indices: &[u8; 2]) -> Option<[KeyShare; 2]> {
        let keys = self.keys.read().unwrap();
        let stored = keys.get(key_id)?;

        let s1 = stored.shares.iter().find(|s| s.share_index == share_indices[0])?.clone();
        let s2 = stored.shares.iter().find(|s| s.share_index == share_indices[1])?.clone();

        Some([s1, s2])
    }

    /// Record a signing operation and increment counter
    pub fn record_sign(&self, key_id: &str, shares_used: &[u8], success: bool, message_hash: &str) {
        if let Some(stored) = self.keys.write().unwrap().get_mut(key_id) {
            stored.sign_count += 1;
        }
        self.log_audit_with_hash(key_id, "sign", success, shares_used, message_hash);
    }

    /// Get the audit log
    pub fn get_audit_log(&self, key_id: Option<&str>, limit: usize) -> Vec<AuditEntry> {
        let log = self.audit_log.read().unwrap();
        let filtered: Vec<_> = if let Some(kid) = key_id {
            log.iter().filter(|e| e.key_id == kid).cloned().collect()
        } else {
            log.iter().cloned().collect()
        };
        filtered.into_iter().rev().take(limit).collect()
    }

    /// Delete a key (revocation)
    pub fn revoke_key(&self, key_id: &str) -> bool {
        let removed = self.keys.write().unwrap().remove(key_id).is_some();
        if removed {
            self.log_audit(key_id, "revoke", true, &[]);
        }
        removed
    }

    /// List all key IDs with metadata
    pub fn list_keys(&self) -> Vec<KeyInfo> {
        self.keys.read().unwrap().iter().map(|(id, k)| KeyInfo {
            key_id: id.clone(),
            public_key: hex::encode(k.public_key),
            share_count: k.shares.len(),
            sign_count: k.sign_count,
            created_at: k.created_at.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        }).collect()
    }

    fn log_audit(&self, key_id: &str, operation: &str, success: bool, shares_used: &[u8]) {
        self.log_audit_with_hash(key_id, operation, success, shares_used, "");
    }

    fn log_audit_with_hash(&self, key_id: &str, operation: &str, success: bool, shares_used: &[u8], message_hash: &str) {
        let entry = AuditEntry {
            timestamp: chrono_now(),
            key_id: key_id.to_string(),
            operation: operation.to_string(),
            success,
            shares_used: shares_used.to_vec(),
            message_hash: message_hash.to_string(),
        };
        self.audit_log.write().unwrap().push(entry);
    }
}

#[derive(serde::Serialize)]
pub struct KeyInfo {
    pub key_id: String,
    pub public_key: String,
    pub share_count: usize,
    pub sign_count: u64,
    pub created_at: u64,
}

fn chrono_now() -> String {
    // Simple ISO 8601 timestamp
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("{}Z", d.as_secs())
}
