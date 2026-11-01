use std::{collections::HashMap, fs::File, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}};

use serde::{Deserialize, Serialize};
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::DecoderOptions,
    errors::Error as SymphoniaError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const WHISPER_SAMPLE_RATE: u32 = 16_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub no_speech_probability: f32,
    #[serde(default)]
    pub language: String,
}

static MODEL_CONTEXTS: OnceLock<Mutex<HashMap<PathBuf, Arc<WhisperContext>>>> = OnceLock::new();

fn model_context(model_path: &Path) -> Result<Arc<WhisperContext>, String> {
    let cache = MODEL_CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut contexts = cache.lock().map_err(|_| "The local transcription model cache is unavailable.".to_string())?;
    if let Some(context) = contexts.get(model_path) { return Ok(context.clone()); }
    let context = Arc::new(WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|error| format!("Could not load the local transcription model: {error}"))?);
    contexts.clear();
    contexts.insert(model_path.to_path_buf(), context.clone());
    Ok(context)
}

#[derive(Debug, Clone)]
pub struct SpeakerAssignment {
    pub cluster: usize,
    pub confidence: f32,
    pub overlap: bool,
}

/// Offline acoustic diarization baseline. It clusters timestamp-aligned speech
/// windows using pitch, energy, zero-crossing, and spectral-change features.
/// Ambiguous windows are deliberately marked low-confidence/overlap so the UI
/// can ask for review instead of presenting a guessed identity as fact.
pub fn diarize(path: &Path, ranges: &[(i64, i64)]) -> Result<Vec<SpeakerAssignment>, String> {
    let (samples, sample_rate) = decode_audio(path)?;
    let samples = resample_mono(&samples, sample_rate, WHISPER_SAMPLE_RATE);
    if ranges.is_empty() {
        return Ok(vec![]);
    }
    let mut features = ranges
        .iter()
        .map(|&(start, end)| {
            let start_sample =
                ((start.max(0) as u64 * WHISPER_SAMPLE_RATE as u64) / 1_000) as usize;
            let end_sample =
                ((end.max(start + 1) as u64 * WHISPER_SAMPLE_RATE as u64) / 1_000) as usize;
            acoustic_features(
                &samples[start_sample.min(samples.len())..end_sample.min(samples.len())],
            )
        })
        .collect::<Vec<_>>();
    normalize_features(&mut features);
    let cluster_count = if features.len() < 4 {
        1
    } else if features.len() >= 15 {
        3
    } else {
        2
    };
    let (clusters, centers) = kmeans(&features, cluster_count);
    Ok(features
        .iter()
        .enumerate()
        .map(|(index, feature)| {
            let own = distance(feature, &centers[clusters[index]]);
            let alternative = centers
                .iter()
                .enumerate()
                .filter(|(center, _)| *center != clusters[index])
                .map(|(_, center)| distance(feature, center))
                .fold(f32::INFINITY, f32::min);
            let confidence = if alternative.is_finite() {
                (1.0 - own / alternative.max(0.001)).clamp(0.0, 1.0)
            } else {
                0.45
            };
            SpeakerAssignment {
                cluster: clusters[index],
                confidence,
                overlap: cluster_count > 1 && (confidence < 0.18 || feature[0] > 1.15),
            }
        })
        .collect())
}

fn acoustic_features(samples: &[f32]) -> [f32; 5] {
    if samples.len() < 64 {
        return [0.0; 5];
    }
    let rms =
        (samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32).sqrt();
    let zcr = samples
        .windows(2)
        .filter(|pair| pair[0].is_sign_positive() != pair[1].is_sign_positive())
        .count() as f32
        / samples.len() as f32;
    let diff = samples
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .sum::<f32>()
        / samples.len() as f32;
    let mut best_lag = 80usize;
    let mut best_correlation = f32::MIN;
    let analysis_len = samples.len().min(16_000);
    for lag in (40..320).step_by(4) {
        if lag >= analysis_len {
            break;
        }
        let correlation = samples[..analysis_len - lag]
            .iter()
            .zip(&samples[lag..analysis_len])
            .map(|(left, right)| left * right)
            .sum::<f32>()
            / (analysis_len - lag) as f32;
        if correlation > best_correlation {
            best_correlation = correlation;
            best_lag = lag;
        }
    }
    let pitch = WHISPER_SAMPLE_RATE as f32 / best_lag as f32;
    let crest = samples
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f32, f32::max)
        / rms.max(0.0001);
    [rms.ln_1p(), zcr, diff, pitch / 400.0, crest / 10.0]
}

fn normalize_features(features: &mut [[f32; 5]]) {
    for dimension in 0..5 {
        let mean = features
            .iter()
            .map(|feature| feature[dimension])
            .sum::<f32>()
            / features.len() as f32;
        let deviation = (features
            .iter()
            .map(|feature| (feature[dimension] - mean).powi(2))
            .sum::<f32>()
            / features.len() as f32)
            .sqrt()
            .max(0.0001);
        for feature in features.iter_mut() {
            feature[dimension] = (feature[dimension] - mean) / deviation;
        }
    }
}

fn distance(left: &[f32; 5], right: &[f32; 5]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f32>()
        .sqrt()
}

fn kmeans(features: &[[f32; 5]], count: usize) -> (Vec<usize>, Vec<[f32; 5]>) {
    let count = count.clamp(1, features.len());
    let clean = features
        .iter()
        .filter(|feature| feature[0] <= 1.15)
        .copied()
        .collect::<Vec<_>>();
    let mut ordered = if clean.len() >= count {
        clean
    } else {
        features.to_vec()
    };
    ordered.sort_by(|left, right| left[3].total_cmp(&right[3]));
    let mut centers = if count == 1 {
        vec![ordered[ordered.len() / 2]]
    } else {
        (0..count)
            .map(|index| ordered[index * (ordered.len() - 1) / (count - 1)])
            .collect::<Vec<_>>()
    };
    let mut assignments = vec![0; features.len()];
    for _ in 0..20 {
        for (index, feature) in features.iter().enumerate() {
            assignments[index] = centers
                .iter()
                .enumerate()
                .min_by(|(_, left), (_, right)| {
                    distance(feature, left).total_cmp(&distance(feature, right))
                })
                .map(|(cluster, _)| cluster)
                .unwrap_or(0);
        }
        for (cluster, center) in centers.iter_mut().enumerate() {
            let members = features
                .iter()
                .zip(&assignments)
                .filter(|(feature, assigned)| **assigned == cluster && feature[0] <= 1.15)
                .map(|(feature, _)| feature)
                .collect::<Vec<_>>();
            if members.is_empty() {
                continue;
            }
            for dimension in 0..5 {
                center[dimension] = members
                    .iter()
                    .map(|feature| feature[dimension])
                    .sum::<f32>()
                    / members.len() as f32;
            }
        }
    }
    (assignments, centers)
}

pub fn transcribe_configured(
    model_path: &Path,
    audio_path: &Path,
    language: Option<&str>,
    translate: bool,
    progress: Option<Box<dyn FnMut(i32) + Send>>,
    abort: Option<Box<dyn FnMut() -> bool + Send>>,
) -> Result<Vec<TranscriptSegment>, String> {
    transcribe_with_mode(model_path, audio_path, language, translate, progress, abort, false)
}

pub fn transcribe_live_configured(model_path: &Path, audio_path: &Path, language: Option<&str>, translate: bool) -> Result<Vec<TranscriptSegment>, String> {
    match transcribe_with_mode(model_path, audio_path, language, translate, None, None, true) {
        Err(error) if error == "No speech was detected in the recording." => Ok(Vec::new()),
        result => result,
    }
}

fn transcribe_with_mode(
    model_path: &Path, audio_path: &Path, language: Option<&str>, translate: bool,
    progress: Option<Box<dyn FnMut(i32) + Send>>, abort: Option<Box<dyn FnMut() -> bool + Send>>, live: bool,
) -> Result<Vec<TranscriptSegment>, String> {
    let (samples, sample_rate) = decode_audio(audio_path)?;
    if samples.is_empty() {
        return Err("The recording does not contain decodable audio.".into());
    }
    let samples = resample_mono(&samples, sample_rate, WHISPER_SAMPLE_RATE);
    let context = model_context(model_path)?;
    let mut state = context
        .create_state()
        .map_err(|error| format!("Could not initialize local transcription: {error}"))?;
    let strategy = if live { SamplingStrategy::Greedy { best_of: 1 } } else { SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 } };
    let mut params = FullParams::new(strategy);
    params.set_n_threads(
        std::thread::available_parallelism()
            .map(|threads| threads.get().min(8) as i32)
            .unwrap_or(4),
    );
    params.set_translate(translate);
    params.set_language(language.filter(|value| *value != "auto"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_token_timestamps(true);
    params.set_suppress_blank(true);
    params.set_no_context(true);
    if let Some(callback) = progress { params.set_progress_callback_safe::<_, Box<dyn FnMut(i32) + Send>>(Some(callback)); }
    if let Some(callback) = abort { params.set_abort_callback_safe::<_, Box<dyn FnMut() -> bool + Send>>(Some(callback)); }
    state
        .full(params, &samples)
        .map_err(|error| format!("Local transcription failed: {error}"))?;
    let detected_language = whisper_rs::get_lang_str(state.full_lang_id_from_state()).unwrap_or(language.unwrap_or("auto")).to_string();

    let mut result = Vec::new();
    let mut previous = String::new();
    for segment in state.as_iter() {
        let text = segment.to_string().trim().to_owned();
        let normalized = text.to_lowercase();
        let no_speech_probability = segment.no_speech_probability();
        let start_sample = ((segment.start_timestamp().max(0) as usize * WHISPER_SAMPLE_RATE as usize) / 100).min(samples.len());
        let end_sample = ((segment.end_timestamp().max(segment.start_timestamp() + 1) as usize * WHISPER_SAMPLE_RATE as usize) / 100).min(samples.len());
        let energy = rms(&samples[start_sample..end_sample]);
        if text.is_empty()
            || no_speech_probability > 0.62
            || energy < 0.0035
            || normalized == previous
            || looks_like_hallucination(&normalized)
        {
            continue;
        }
        previous = normalized;
        result.push(TranscriptSegment {
            start_ms: segment.start_timestamp() * 10,
            end_ms: segment.end_timestamp() * 10,
            text,
            no_speech_probability,
            language: detected_language.clone(),
        });
    }
    if result.is_empty() {
        return Err("No speech was detected in the recording.".into());
    }
    Ok(result)
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() { return 0.0; }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

fn looks_like_hallucination(text: &str) -> bool {
    let cleaned = text.trim_matches(|character: char| character.is_whitespace() || matches!(character, '[' | ']' | '(' | ')'));
    if cleaned.is_empty() { return true; }
    let known = ["silence", "blank_audio", "blank audio", "music", "พากษ์เสียงไทย", "subtitles by", "thank you for watching"];
    if known.iter().any(|phrase| cleaned.eq_ignore_ascii_case(phrase) || cleaned.to_lowercase().contains(phrase)) { return true; }
    let words = cleaned.split_whitespace().collect::<Vec<_>>();
    if words.len() >= 4 {
        let distinct = words.iter().map(|word| word.to_lowercase()).collect::<std::collections::HashSet<_>>();
        if distinct.len() == 1 { return true; }
    }
    false
}

#[cfg(test)]
#[test]
#[ignore = "requires explicitly supplied local audio and Whisper model"]
fn inspect_live_chunk_with_local_model() {
    let model = std::env::var("MOCHI_TEST_WHISPER_MODEL").unwrap();
    let audio = std::env::var("MOCHI_TEST_AUDIO_CHUNK").unwrap();
    match transcribe_live_configured(Path::new(&model), Path::new(&audio), Some("auto"), false) {
        Ok(segments) => println!("Live chunk decoded: {} speech segments", segments.len()),
        Err(error) => panic!("Live chunk processing error: {error}"),
    }
}

fn decode_audio(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let file = File::open(path).map_err(|error| format!("Could not open recording: {error}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| format!("Unsupported or damaged recording: {error}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.sample_rate.is_some())
        .ok_or_else(|| "The recording has no audio track.".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| format!("The recording codec is not supported: {error}"))?;
    let mut mono = Vec::new();
    let mut source_rate = None;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(error) => return Err(format!("Could not read recording: {error}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(format!("Could not decode recording: {error}")),
        };
        append_mono(decoded, &mut mono, &mut source_rate)?;
    }
    Ok((mono, source_rate.unwrap_or(WHISPER_SAMPLE_RATE)))
}

fn append_mono(
    decoded: AudioBufferRef<'_>,
    output: &mut Vec<f32>,
    source_rate: &mut Option<u32>,
) -> Result<(), String> {
    let spec = *decoded.spec();
    if source_rate.is_some_and(|rate| rate != spec.rate) {
        return Err("The recording changes sample rate mid-stream.".into());
    }
    *source_rate = Some(spec.rate);
    let channels = spec.channels.count();
    if channels == 0 {
        return Ok(());
    }
    let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
    buffer.copy_interleaved_ref(decoded);
    for frame in buffer.samples().chunks_exact(channels) {
        output.push(frame.iter().sum::<f32>() / channels as f32);
    }
    Ok(())
}

fn resample_mono(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == target_rate {
        return input.to_vec();
    }
    let output_len = ((input.len() as u64 * target_rate as u64) / source_rate as u64) as usize;
    let ratio = source_rate as f64 / target_rate as f64;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * ratio;
            let left = position.floor() as usize;
            let right = (left + 1).min(input.len() - 1);
            let fraction = (position - left as f64) as f32;
            input[left] * (1.0 - fraction) + input[right] * fraction
        })
        .collect()
}

pub fn render_transcript(segments: &[TranscriptSegment]) -> String {
    segments
        .iter()
        .map(|segment| {
            let total_seconds = segment.start_ms / 1_000;
            format!(
                "[{:02}:{:02}] {}",
                total_seconds / 60,
                total_seconds % 60,
                segment.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn resampling_preserves_duration() {
        let input = vec![0.25; 48_000];
        let output = resample_mono(&input, 48_000, 16_000);
        assert_eq!(output.len(), 16_000);
        assert!(output
            .iter()
            .all(|sample| (*sample - 0.25).abs() < f32::EPSILON));
    }

    #[test]
    fn transcript_rendering_includes_clickable_time_basis() {
        let rendered = render_transcript(&[TranscriptSegment {
            start_ms: 65_000,
            end_ms: 70_000,
            text: "A decision was made.".into(),
            no_speech_probability: 0.01,
            language: "en".into(),
        }]);
        assert_eq!(rendered, "[01:05] A decision was made.");
    }

    #[test]
    fn silence_captions_and_repetition_are_rejected() {
        assert!(looks_like_hallucination("[ Silence ]"));
        assert!(looks_like_hallucination("[BLANK_AUDIO]"));
        assert!(looks_like_hallucination("الله الله الله الله"));
        assert!(looks_like_hallucination("[ พากษ์เสียงไทย ]"));
        assert!(!looks_like_hallucination("We agreed to ship on Friday"));
    }

    #[test]
    fn acoustic_clusters_separate_distinct_voice_profiles() {
        let low = [0.0, -1.0, -0.8, -1.1, 0.0];
        let high = [0.1, 1.0, 0.9, 1.2, 0.1];
        let features = vec![low, low, high, high];
        let (assignments, _) = kmeans(&features, 2);
        assert_eq!(assignments[0], assignments[1]);
        assert_eq!(assignments[2], assignments[3]);
        assert_ne!(assignments[0], assignments[2]);
    }

    fn write_test_wav(path: &Path, samples: &[f32]) {
        let data_size = (samples.len() * 2) as u32;
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&WHISPER_SAMPLE_RATE.to_le_bytes()).unwrap();
        file.write_all(&(WHISPER_SAMPLE_RATE * 2).to_le_bytes())
            .unwrap();
        file.write_all(&2_u16.to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_size.to_le_bytes()).unwrap();
        for sample in samples {
            file.write_all(&((*sample * i16::MAX as f32) as i16).to_le_bytes())
                .unwrap();
        }
    }

    #[test]
    fn overlapping_audio_does_not_destabilize_speaker_turns() {
        let rate = WHISPER_SAMPLE_RATE as usize;
        let mut samples = Vec::new();
        for segment in 0..6 {
            for index in 0..rate {
                let time = index as f32 / WHISPER_SAMPLE_RATE as f32;
                let low = (time * 120.0 * std::f32::consts::TAU).sin() * 0.22;
                let high = (time * 260.0 * std::f32::consts::TAU).sin() * 0.18;
                samples.push(match segment {
                    0 | 1 => low,
                    2 | 3 => high,
                    _ => low + high,
                });
            }
        }
        let path = std::env::temp_dir().join(format!("mochi-overlap-{}.wav", uuid::Uuid::new_v4()));
        write_test_wav(&path, &samples);
        let ranges = (0..6)
            .map(|index| (index * 1_000, (index + 1) * 1_000))
            .collect::<Vec<_>>();
        let assignments = diarize(&path, &ranges).unwrap();
        let _ = std::fs::remove_file(path);
        assert_eq!(assignments.len(), 6);
        assert_eq!(assignments[0].cluster, assignments[1].cluster);
        assert_eq!(assignments[2].cluster, assignments[3].cluster);
        assert_ne!(assignments[0].cluster, assignments[2].cluster);
        assert!(assignments[4].overlap || assignments[5].overlap);
    }
}
