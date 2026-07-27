import { Platform } from 'react-native';
import { File as ExpoFile, Paths } from 'expo-file-system';
import type { UploadableFile } from 'education-assistant-client';

/**
 * One small, original, fictional document for the dev-only "Load sample
 * corpus" action (milestone 8 §12) — so a developer without access to a
 * real private corpus can still exercise chat/search/citations end to end.
 *
 * Entirely made up for this project: no real curriculum, institution, or
 * publication. Never mix this with real evaluation results (see
 * rag-backend/evaluation/README.md) — it exists only to demonstrate the
 * workflow, not to produce a real answer-quality signal.
 *
 * Filename carries the `SAMPLE_FILENAME_PREFIX` so source cards can label
 * it distinctly (see SourceCard.tsx) instead of presenting it as if it
 * were real research evidence.
 */

export const SAMPLE_FILENAME_PREFIX = 'sample-';

export const SAMPLE_DOCUMENT_FILENAME = `${SAMPLE_FILENAME_PREFIX}fictional-grade4-curriculum.md`;

export const SAMPLE_DOCUMENT_TITLE =
  'Fictional Grade 4 Foundational Reading Skills Curriculum Overview (Sample)';

export const SAMPLE_DOCUMENT_TEXT = `# Fictional Grade 4 Foundational Reading Skills Curriculum Overview (Sample)

This is a fictional, original sample document created for this project. It does not describe a
real school, district, or published curriculum. It exists only so the Education Assistant example
app can be exercised end to end without a real private document corpus.

## Purpose

This overview describes the fictional Grade 4 foundational reading skills sequence used to
demonstrate the app's chat, search, and citation features.

## Weekly sequence

The fictional curriculum allocates instructional time as follows:

- Weeks 1-4: multisyllabic decoding review, twenty minutes daily.
- Weeks 5-9: morphology (common prefixes and suffixes), fifteen minutes daily.
- Weeks 10-14: fluency practice through repeated oral reading, twenty minutes daily, three times
  per week.
- Weeks 15-18: vocabulary instruction tied to the current science and social studies units.

## Assessment checkpoints

Fictional checkpoint assessments occur at the end of week 9 and week 18, each covering the skills
introduced since the previous checkpoint. Checkpoint results are used only to place students into
small-group instruction for the following unit, not for formal grading.

## Materials

Materials referenced by this fictional curriculum are decodable text sets aligned to the
multisyllabic decoding sequence, a shared classroom vocabulary journal, and teacher-created fluency
passages matched to each unit's science or social studies topic.
`;

export function isSampleSource(sourceFilename: string | null | undefined): boolean {
  return (sourceFilename ?? '').toLowerCase().startsWith(SAMPLE_FILENAME_PREFIX);
}

const SAMPLE_DOCUMENT_MIME_TYPE = 'text/markdown';

/**
 * Builds the sample document as an UploadableFile for the current platform.
 *
 * expo-file-system's File/Directory classes (Paths.cache, file.create(),
 * file.write()) are backed by native JSI bindings that the web platform
 * doesn't implement — calling them on web throws
 * ("this.validatePath is not a function"). Web has no filesystem need here
 * anyway: it builds a standards-based in-memory browser File directly from
 * the sample text and appends it straight to FormData (see
 * EducationAssistantClient.appendUploadableFile, which already accepts a
 * File/Blob as-is — UploadableFile is a union of File | Blob |
 * { uri, name, type } for exactly this reason, so no SDK change is needed).
 * Native platforms keep writing to the cache directory unchanged, since
 * DocumentPicker-sourced files are also uri-based and this keeps the sample
 * upload on the exact same code path as a real picked file.
 *
 * Throws (does not silently swap in a broken file) if the current runtime
 * can construct neither — callers must catch this instead of letting it
 * escape as an unhandled render/event exception.
 */
export function buildSampleUploadFile(): UploadableFile {
  if (Platform.OS === 'web') {
    // `File` is already bound to expo-file-system's native-backed class by
    // the import above; the browser's constructor must be reached via
    // globalThis to avoid that shadowing. Native runtimes have no global
    // File/Blob, so this branch never executes there — checked, not assumed.
    const BrowserFile = globalThis.File;
    if (typeof BrowserFile !== 'function') {
      throw new Error(
        'This browser does not provide the File API needed to load the sample document.'
      );
    }
    return new BrowserFile([SAMPLE_DOCUMENT_TEXT], SAMPLE_DOCUMENT_FILENAME, {
      type: SAMPLE_DOCUMENT_MIME_TYPE,
    });
  }

  const file = new ExpoFile(Paths.cache, SAMPLE_DOCUMENT_FILENAME);
  file.create({ overwrite: true });
  file.write(SAMPLE_DOCUMENT_TEXT);
  return { uri: file.uri, name: SAMPLE_DOCUMENT_FILENAME, type: SAMPLE_DOCUMENT_MIME_TYPE };
}
