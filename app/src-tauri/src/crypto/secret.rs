use zeroize::Zeroize;

/// A secret byte vector that zeroizes on drop.
/// Uses `Vec<u8>` internally for heap allocation and zeroizing.
#[derive(Clone)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn new(data: Vec<u8>) -> Self {
        Self(data)
    }

    pub fn from_slice(data: &[u8]) -> Self {
        Self(data.to_vec())
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

// SecretBytes does NOT implement Debug or Serialize.
impl std::fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretBytes")
            .field("len", &self.0.len())
            .finish()
    }
}

/// A fixed-size 32-byte secret key (e.g., DEK, vault key).
#[derive(Clone)]
pub struct SecretKey([u8; 32]);

impl SecretKey {
    pub fn new(key: [u8; 32]) -> Self {
        Self(key)
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretKey").finish()
    }
}

impl From<[u8; 32]> for SecretKey {
    fn from(key: [u8; 32]) -> Self {
        Self(key)
    }
}

/// Zeroizing buffer for plaintext operations.
pub struct ZeroizingBuffer(Vec<u8>);

impl ZeroizingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self(vec![0u8; capacity])
    }

    pub fn with_data(data: Vec<u8>) -> Self {
        Self(data)
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.0
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    pub fn into_vec(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

impl Drop for ZeroizingBuffer {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
