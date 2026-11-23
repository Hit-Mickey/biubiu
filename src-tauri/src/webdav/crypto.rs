#[cfg(target_os = "windows")]
use base64::engine::general_purpose::STANDARD;
#[cfg(target_os = "windows")]
use base64::Engine;

#[cfg(target_os = "windows")]
pub fn encrypt_secret(plain: &str) -> Result<String, String> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let bytes = plain.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("DPAPI encrypt failed: {e}"))?;
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let encoded = format!("dpapi:{}", STANDARD.encode(slice));
        let _ = LocalFree(windows::Win32::Foundation::HLOCAL(output.pbData as _));
        Ok(encoded)
    }
}

#[cfg(target_os = "windows")]
pub fn decrypt_secret(encoded: &str) -> Result<String, String> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let b64 = encoded
        .strip_prefix("dpapi:")
        .ok_or_else(|| "unsupported secret format".to_string())?;
    let raw = STANDARD.decode(b64).map_err(|e| e.to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: raw.len() as u32,
        pbData: raw.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("DPAPI decrypt failed: {e}"))?;
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let text = String::from_utf8(slice.to_vec()).map_err(|e| e.to_string())?;
        let _ = LocalFree(windows::Win32::Foundation::HLOCAL(output.pbData as _));
        Ok(text)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn encrypt_secret(plain: &str) -> Result<String, String> {
    let reference = format!("keyring:{}", uuid::Uuid::new_v4());
    credential(&reference)?
        .set_password(plain)
        .map_err(|e| e.to_string())?;
    Ok(reference)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn credential(reference: &str) -> Result<keyring::Entry, String> {
    let id = reference
        .strip_prefix("keyring:")
        .ok_or("unsupported secret format")?;
    let id = uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    keyring::Entry::new("com.hitmickey.biubiu.webdav", &id.to_string()).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn decrypt_secret(reference: &str) -> Result<String, String> {
    credential(reference)?
        .get_password()
        .map_err(|e| e.to_string())
}

pub fn forget_secret(_reference: &str) {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    if let Ok(entry) = credential(_reference) {
        let _ = entry.delete_credential();
    }
}

#[cfg(target_os = "android")]
pub fn encrypt_secret(plain: &str) -> Result<String, String> {
    crate::android::secret("encrypt", plain)
}
#[cfg(target_os = "android")]
pub fn decrypt_secret(encoded: &str) -> Result<String, String> {
    crate::android::secret("decrypt", encoded)
}
