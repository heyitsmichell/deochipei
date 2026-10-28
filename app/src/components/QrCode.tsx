import createQrCode from "qrcode-generator";
import { useMemo } from "react";
import Svg, { Path, Rect } from "react-native-svg";

// Scanners need a light border around the code ("quiet zone") of 4 modules.
const QUIET = 4;

/** A QR code drawn as one SVG path, so it stays sharp and cheap to render. */
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const { path, count } = useMemo(() => {
    const qr = createQrCode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    // One rectangle per horizontal run of dark modules keeps the path short.
    let d = "";
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (!qr.isDark(row, col)) continue;
        const start = col;
        while (col + 1 < n && qr.isDark(row, col + 1)) col++;
        d += `M${start} ${row}h${col - start + 1}v1h${-(col - start + 1)}z`;
      }
    }
    return { path: d, count: n };
  }, [value]);

  const extent = count + QUIET * 2;
  return (
    <Svg width={size} height={size} viewBox={`${-QUIET} ${-QUIET} ${extent} ${extent}`}>
      <Rect x={-QUIET} y={-QUIET} width={extent} height={extent} fill="#fff" />
      <Path d={path} fill="#000" />
    </Svg>
  );
}
