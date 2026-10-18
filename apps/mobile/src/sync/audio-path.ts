/**
 * Where a recording lives on this phone (pure). `audio_attachments.local_path` is stored relative
 * to the app's Documents folder (`recordings/<id>.wav`): iOS changes the container's absolute
 * path on every app update or reinstall, so an absolute `file://` path goes stale. Resolve it at
 * the moment of use. Rows saved before this rule hold absolute paths; when one no longer exists,
 * the file is looked up by name in today's recordings folder.
 */

export const RECORDINGS_DIR = 'recordings/'

export function storedRecordingPath(fileName: string): string {
  return `${RECORDINGS_DIR}${fileName}`
}

const withSlash = (uri: string) => (uri.endsWith('/') ? uri : `${uri}/`)

/** The file's uri today, given the Documents folder's uri. */
export function resolveRecordingUri(
  localPath: string,
  documentsUri: string,
  exists: (uri: string) => boolean,
): string {
  const docs = withSlash(documentsUri)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(localPath)) return `${docs}${localPath.replace(/^\/+/, '')}`
  if (exists(localPath)) return localPath
  const name = localPath.slice(localPath.lastIndexOf('/') + 1)
  return `${docs}${RECORDINGS_DIR}${name}`
}
