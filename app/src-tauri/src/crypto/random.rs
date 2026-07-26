use rand::RngCore;

/// Generate `n` cryptographically random bytes using the OS CSPRNG.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    buf
}

/// Generate a random 32-byte key (e.g., DEK).
pub fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    key
}

/// Generate a random 16-byte UUID.
pub fn random_uuid() -> [u8; 16] {
    let mut uuid = [0u8; 16];
    rand::rng().fill_bytes(&mut uuid);
    uuid
}

/// Generate a random 16-byte nonce prefix.
pub fn random_nonce_prefix() -> [u8; 16] {
    let mut prefix = [0u8; 16];
    rand::rng().fill_bytes(&mut prefix);
    prefix
}

/// Generate a random 16-byte salt for Argon2id.
pub fn random_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    salt
}

/// Generate a full random 24-byte nonce for XChaCha20-Poly1305 key wrapping.
pub fn random_wrap_nonce() -> [u8; 24] {
    let mut nonce = [0u8; 24];
    rand::rng().fill_bytes(&mut nonce);
    nonce
}

/// Generate a random 64-bit unsigned integer.
pub fn random_u64() -> u64 {
    rand::rng().next_u64()
}
