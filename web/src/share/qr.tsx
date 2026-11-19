// A QR code for a share link, drawn in the text colour (qrcode-generator, MIT).
import qrcode from 'qrcode-generator';

export function Qr({ text, size = 220 }: { text: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const q = 4;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + q} ${y + q}h1v1h-1z`;
  return (
    <svg class="sh-qr" width={size} height={size} viewBox={`0 0 ${n + q * 2} ${n + q * 2}`} shape-rendering="crispEdges" role="img" aria-label="二维码">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
