/**
 * `@vectors` is a Jest moduleNameMapper alias for the repo-root
 * protocol/vectors.json — the frozen frame contract the ESP32 firmware also
 * self-tests against. Declared ambiently because the real file lives outside
 * this project's rootDir, so tsc cannot resolve it through paths.
 */
declare module '@vectors' {
  export type Vector = {
    name: string;
    direction: 'app_to_device' | 'device_to_app';
    frame: Record<string, unknown> & { op: string; seq: number };
    bytes: string;
  };
  const doc: { protocol_version: number; note: string; vectors: Vector[] };
  export default doc;
}
