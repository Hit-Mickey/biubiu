use std::path::{Path, PathBuf};

const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;

pub struct WebDavCache {
    dir: PathBuf,
}

impl WebDavCache {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("webdav-cache"),
        }
    }

    pub fn entry_path(&self, version: &str) -> Option<PathBuf> {
        if version.is_empty() || !version.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        Some(self.dir.join(version))
    }

    pub fn get_cached_file(&self, version: &str) -> Option<PathBuf> {
        let p = self.entry_path(version)?;
        if p.is_file() {
            Some(p)
        } else {
            None
        }
    }

    pub async fn write_response(
        &self,
        version: &str,
        response: reqwest::Response,
    ) -> Result<(), String> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        let target = self.entry_path(version).ok_or("invalid cache version")?;
        if response
            .content_length()
            .is_some_and(|len| len > MAX_CACHE_BYTES)
        {
            return Ok(());
        }
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|err| err.to_string())?;
        let tmp = tempfile::NamedTempFile::new_in(&self.dir).map_err(|err| err.to_string())?;
        let (file, path) = tmp.into_parts();
        let mut file = tokio::fs::File::from_std(file);
        let mut stream = response.bytes_stream();
        let mut total = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| err.to_string())?;
            total += chunk.len() as u64;
            if total > MAX_CACHE_BYTES {
                return Ok(());
            }
            file.write_all(&chunk)
                .await
                .map_err(|err| err.to_string())?;
        }
        file.flush().await.map_err(|err| err.to_string())?;
        drop(file);
        path.persist(target).map_err(|err| err.to_string())?;
        self.prune();
        Ok(())
    }

    pub fn write_cached_bytes(&self, version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
        let target = self
            .entry_path(version)
            .ok_or_else(|| "invalid cache version".to_string())?;
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = self
            .dir
            .join(format!("{version}.{}.part", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        if target.exists() {
            let _ = std::fs::remove_file(&target);
        }
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        self.prune();
        Ok(target)
    }

    pub fn clear(&self) -> Result<(), String> {
        if self.dir.is_dir() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
        Ok(())
    }

    pub fn prune(&self) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        let mut total: u64 = 0;
        for entry in rd.flatten() {
            let path = entry.path();
            if self
                .entry_path(&entry.file_name().to_string_lossy())
                .is_none()
            {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let size = meta.len();
                    let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    total += size;
                    files.push((path, size, mtime));
                }
            }
        }
        if total <= MAX_CACHE_BYTES {
            return;
        }
        files.sort_by_key(|(_, _, mtime)| *mtime);
        for (path, size, _) in files {
            if total <= MAX_CACHE_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
}
