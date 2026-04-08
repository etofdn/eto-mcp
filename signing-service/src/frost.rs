//! Threshold signing using Shamir's Secret Sharing over Ed25519
//!
//! Phase 3: 2-of-3 Shamir SSS (key assembled briefly for signing)
//! Phase 3.5: True FROST (key never assembled, partial signatures combined)

use ed25519_dalek::{SigningKey, Signature, Signer, VerifyingKey};
use rand::rngs::OsRng;
use sha2::{Sha256, Digest};

/// A key share for threshold signing
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyShare {
    pub share_index: u8,       // 1, 2, or 3
    pub share_bytes: [u8; 32], // The share value
    pub public_key: [u8; 32],  // The combined public key
    pub key_id: String,        // Unique key identifier
}

/// Result of distributed key generation
#[derive(serde::Serialize, serde::Deserialize)]
pub struct DkgResult {
    pub key_id: String,
    pub public_key: [u8; 32],
    pub shares: Vec<KeyShare>,  // 3 shares
}

/// Generate a new keypair and split into 2-of-3 shares
pub fn generate_shares(threshold: u8, total: u8) -> DkgResult {
    assert_eq!(threshold, 2);
    assert_eq!(total, 3);

    // Generate a random Ed25519 signing key
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key = signing_key.verifying_key().to_bytes();
    let secret = signing_key.to_bytes();

    // Shamir's Secret Sharing: f(x) = secret + a1*x (mod L)
    // where L is the Ed25519 scalar order
    let mut a1 = [0u8; 32];
    rand::RngCore::fill_bytes(&mut OsRng, &mut a1);

    // Evaluate polynomial at x=1, x=2, x=3
    let shares: Vec<KeyShare> = (1..=3).map(|i| {
        let share_bytes = evaluate_polynomial(&secret, &a1, i);
        let key_id = hex::encode(&Sha256::digest(&public_key)[..8]);
        KeyShare {
            share_index: i,
            share_bytes,
            public_key,
            key_id: key_id.clone(),
        }
    }).collect();

    let key_id = hex::encode(&Sha256::digest(&public_key)[..8]);
    DkgResult { key_id, public_key, shares }
}

/// Reconstruct the secret key from 2 shares and sign
pub fn sign_with_shares(shares: &[KeyShare; 2], message: &[u8]) -> Result<Signature, String> {
    if shares[0].public_key != shares[1].public_key {
        return Err("Shares belong to different keys".into());
    }

    // Lagrange interpolation to recover secret at x=0
    let secret = lagrange_interpolate(
        shares[0].share_index,
        &shares[0].share_bytes,
        shares[1].share_index,
        &shares[1].share_bytes,
    );

    let signing_key = SigningKey::from_bytes(&secret);

    // Verify the public key matches
    if signing_key.verifying_key().to_bytes() != shares[0].public_key {
        return Err("Reconstructed key doesn't match public key".into());
    }

    Ok(signing_key.sign(message))
}

/// Verify a signature against the public key
pub fn verify_signature(public_key: &[u8; 32], message: &[u8], signature: &Signature) -> bool {
    match VerifyingKey::from_bytes(public_key) {
        Ok(vk) => vk.verify_strict(message, signature).is_ok(),
        Err(_) => false,
    }
}

// --- Scalar arithmetic over Ed25519 order ---
// Ed25519 scalar order L = 2^252 + 27742317777372353535851937790883648493

/// Evaluate f(x) = secret + a1*x in the scalar field (simplified: mod 2^256, good enough for demo)
fn evaluate_polynomial(secret: &[u8; 32], a1: &[u8; 32], x: u8) -> [u8; 32] {
    // a1 * x
    let mut product = scalar_mul_small(a1, x);
    // secret + a1*x
    scalar_add(&mut product, secret);
    product
}

/// Lagrange interpolation at x=0 from two points (x1, y1) and (x2, y2)
/// f(0) = y1 * (0-x2)/(x1-x2) + y2 * (0-x1)/(x2-x1)
///       = y1 * x2/(x2-x1) + y2 * (-x1)/(x2-x1)  [note: negation in field]
///       = y1 * x2/(x2-x1) + y2 * x1/(x1-x2)
fn lagrange_interpolate(x1: u8, y1: &[u8; 32], x2: u8, y2: &[u8; 32]) -> [u8; 32] {
    // For small indices (1,2,3), we can compute the coefficients directly
    // coeff1 = x2 / (x2 - x1), coeff2 = x1 / (x1 - x2)
    // Since we're working mod L, we need modular inverse
    // For the common cases: (1,2), (1,3), (2,3), precompute:
    let (_c1_num, _c1_den, _c2_num, _c2_den) = match (x1, x2) {
        (1, 2) => (2i16, 1i16, 1i16, -1i16),   // c1=2/1=2, c2=1/-1=-1
        (1, 3) => (3, 2, 1, -2),                  // c1=3/2, c2=1/-2
        (2, 3) => (3, 1, 2, -1),                  // c1=3/1=3, c2=2/-1=-2
        (2, 1) => (1, -1, 2, 1),
        (3, 1) => (1, -2, 3, 2),
        (3, 2) => (2, -1, 3, 1),
        _ => panic!("unsupported share indices"),
    };

    // Simplified: for indices 1,2,3 the fractions are small integers or halves
    // Use a simpler approach: work with integers and divide at the end
    let diff = (x2 as i16 - x1 as i16).unsigned_abs() as u8;

    // term1 = y1 * x2
    let term1 = scalar_mul_small(y1, x2);
    // term2 = y2 * x1
    let term2 = scalar_mul_small(y2, x1);

    if x2 > x1 {
        // f(0) = (term1 - term2) / diff
        let mut result = term1;
        scalar_sub(&mut result, &term2);
        scalar_div_small(&mut result, diff);
        result
    } else {
        // f(0) = (term2 - term1) / diff
        let mut result = term2;
        scalar_sub(&mut result, &term1);
        scalar_div_small(&mut result, diff);
        result
    }
}

/// Multiply a 256-bit scalar by a small u8 value (mod L approximation)
fn scalar_mul_small(a: &[u8; 32], b: u8) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut carry: u16 = 0;
    for i in 0..32 {
        let prod = (a[i] as u16) * (b as u16) + carry;
        result[i] = prod as u8;
        carry = prod >> 8;
    }
    result
}

/// Add two 256-bit scalars: a += b
fn scalar_add(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut carry: u16 = 0;
    for i in 0..32 {
        let sum = (a[i] as u16) + (b[i] as u16) + carry;
        a[i] = sum as u8;
        carry = sum >> 8;
    }
}

/// Subtract: a -= b
fn scalar_sub(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut borrow: i16 = 0;
    for i in 0..32 {
        let diff = (a[i] as i16) - (b[i] as i16) - borrow;
        if diff < 0 {
            a[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            a[i] = diff as u8;
            borrow = 0;
        }
    }
}

/// Divide scalar by small value (for Lagrange with small indices)
fn scalar_div_small(a: &mut [u8; 32], d: u8) {
    let mut remainder: u16 = 0;
    for i in (0..32).rev() {
        let dividend = (remainder << 8) | (a[i] as u16);
        a[i] = (dividend / d as u16) as u8;
        remainder = dividend % d as u16;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_and_sign() {
        let dkg = generate_shares(2, 3);
        assert_eq!(dkg.shares.len(), 3);

        let message = b"hello world";

        // Sign with shares 1 and 2
        let sig = sign_with_shares(
            &[dkg.shares[0].clone(), dkg.shares[1].clone()],
            message,
        ).unwrap();

        assert!(verify_signature(&dkg.public_key, message, &sig));

        // Sign with shares 1 and 3
        let sig2 = sign_with_shares(
            &[dkg.shares[0].clone(), dkg.shares[2].clone()],
            message,
        ).unwrap();

        assert!(verify_signature(&dkg.public_key, message, &sig2));

        // Sign with shares 2 and 3
        let sig3 = sign_with_shares(
            &[dkg.shares[1].clone(), dkg.shares[2].clone()],
            message,
        ).unwrap();

        assert!(verify_signature(&dkg.public_key, message, &sig3));
    }

    #[test]
    fn test_wrong_shares_rejected() {
        let dkg1 = generate_shares(2, 3);
        let dkg2 = generate_shares(2, 3);

        // Mixing shares from different keys should fail
        let result = sign_with_shares(
            &[dkg1.shares[0].clone(), dkg2.shares[1].clone()],
            b"test",
        );
        assert!(result.is_err());
    }
}
