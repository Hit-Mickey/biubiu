#!/usr/bin/env bash
set -euo pipefail

# Reproduce the small standalone FFmpeg used for audio decoding and download muxing.
root=$(cd "$(dirname "$0")/.." && pwd)
version=8.1.3
checksum=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
cache="$root/.cache/ffmpeg"
mkdir -p "$cache"
cd "$cache"
archive="ffmpeg-$version.tar.xz"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 2 "https://ffmpeg.org/releases/$archive" -o "$archive.part"
  mv "$archive.part" "$archive"
fi
if command -v sha256sum >/dev/null; then
  echo "$checksum  $archive" | sha256sum -c -
else
  echo "$checksum  $archive" | shasum -a 256 -c -
fi
if [[ ! -f "ffmpeg-$version/configure" ]]; then tar xf "$archive"; fi

case "$(uname -s)" in
  MINGW*|MSYS*|CLANG*|UCRT*) name=ffmpeg.exe; extra=(--enable-schannel --target-os=mingw32 --extra-ldflags=-static) ;;
  Darwin) name=ffmpeg-mac; extra=(--enable-securetransport) ;;
  Linux) name=ffmpeg-linux; extra=(--enable-gnutls) ;;
  *) exit 1 ;;
esac
[[ -z "${CC:-}" ]] || extra+=("--cc=$CC")
[[ -z "${FFMPEG_ARCH:-}" ]] || extra+=("--arch=$FFMPEG_ARCH")
mkdir -p "build-$name"
cd "build-$name"
"../ffmpeg-$version/configure" --disable-autodetect --disable-everything --disable-doc --disable-debug \
  --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swscale --disable-x86asm \
  --enable-small --enable-static --disable-shared --enable-ffmpeg "${extra[@]}" \
  --enable-protocol=file,pipe,http,https,tcp,tls \
  --enable-demuxer=mov,matroska,asf,ogg,wav,aiff,flac,mp3,aac,mpegts,ac3,eac3 \
  --enable-decoder=aac,aac_latm,alac,flac,mp3,vorbis,opus,wmav1,wmav2,wmapro,wmalossless,ac3,eac3,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be \
  --enable-encoder=pcm_f32le --enable-muxer=pcm_f32le,mp4,ipod,matroska,flac,mp3 \
  --enable-filter=aresample,aformat,anull --enable-parser=aac,h264,hevc,mpegaudio,flac,vorbis,opus,ac3 \
  --enable-bsf=aac_adtstoasc,h264_metadata,hevc_metadata
"${MAKE:-make}" -j"${JOBS:-4}"
binary=ffmpeg
[[ "$name" != ffmpeg.exe ]] || binary=ffmpeg.exe
install -m 755 "$binary" "$root/src-tauri/resources/ffmpeg/$name"
