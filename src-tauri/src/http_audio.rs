use std::io::{self, Read, Seek, SeekFrom};

use parking_lot::Mutex;
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, ACCEPT_ENCODING, CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use symphonia::core::io::MediaSource;

/// Keeps the current HTTP response open. Symphonia provides the read-ahead buffer.
pub struct HttpAudio {
    client: Client,
    url: String,
    headers: HeaderMap,
    response: Mutex<Option<Response>>,
    position: u64,
    stream_position: u64,
    length: Option<u64>,
}

impl HttpAudio {
    pub fn open(client: Client, url: String, headers: HeaderMap) -> io::Result<Self> {
        let mut reader = Self {
            client,
            url,
            headers,
            response: Mutex::new(None),
            position: 0,
            stream_position: 0,
            length: None,
        };
        reader.connect()?;
        Ok(reader)
    }

    fn connect(&mut self) -> io::Result<()> {
        let mut response = self
            .client
            .get(&self.url)
            .headers(self.headers.clone())
            .header(ACCEPT_ENCODING, "identity")
            .header(RANGE, format!("bytes={}-", self.position))
            .send()
            .and_then(Response::error_for_status)
            .map_err(io::Error::other)?;
        if response.status() == StatusCode::PARTIAL_CONTENT {
            let (range, total) = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("bytes "))
                .and_then(|s| s.split_once('/'))
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "missing Content-Range")
                })?;
            let first = range
                .split_once('-')
                .and_then(|(n, _)| n.parse::<u64>().ok());
            if first != Some(self.position) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unexpected audio range",
                ));
            }
            self.length = total.parse().ok().or(self.length);
        } else {
            self.length = response.content_length();
            // Some WebDAV servers ignore Range. Discard the prefix with bounded memory.
            if self.position > 0 {
                io::copy(&mut (&mut response).take(self.position), &mut io::sink())?;
            }
        }
        self.stream_position = self.position;
        *self.response.get_mut() = Some(response);
        Ok(())
    }
}

impl Read for HttpAudio {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.length.is_some_and(|len| self.position >= len) {
            return Ok(0);
        }
        if self.position != self.stream_position {
            self.connect()?;
        }
        let mut n = self.response.get_mut().as_mut().unwrap().read(buf)?;
        if n == 0 && self.length.is_some_and(|len| self.position < len) {
            self.connect()?;
            n = self.response.get_mut().as_mut().unwrap().read(buf)?;
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
        }
        self.position += n as u64;
        self.stream_position = self.position;
        Ok(n)
    }
}

impl Seek for HttpAudio {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.position = match from {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::Current(d) => self.position.checked_add_signed(d),
            SeekFrom::End(d) => self
                .length
                .ok_or(io::ErrorKind::Unsupported)?
                .checked_add_signed(d),
        }
        .ok_or(io::ErrorKind::InvalidInput)?;
        Ok(self.position)
    }
}

impl MediaSource for HttpAudio {
    fn is_seekable(&self) -> bool {
        self.length.is_some()
    }
    fn byte_len(&self) -> Option<u64> {
        self.length
    }
}
