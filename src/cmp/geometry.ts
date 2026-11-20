import type { CmpFirstLayer } from './types.ts';

/** The boxes of a measured layer's container and controls; equal signatures of two readings mean it stood still. */
export function geometrySignature(layer: CmpFirstLayer): string {
  const box = (b: { x: number; y: number; width: number; height: number } | null | undefined) =>
    b ? `${b.x},${b.y},${b.width},${b.height}` : '-';
  return [box(layer.containerBox), ...layer.buttons.map((b) => box(b.box))].join('|');
}
