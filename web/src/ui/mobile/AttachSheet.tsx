import { MIc } from './MobileApp';

/** The 「+」 sheet under the composer: 拍照 / 相册 / 文件 (and recent photos when the app offers them). */
export function AttachSheet({ onPick }: { onPick: (accept: 'any' | 'image' | 'camera') => void }) {
  return (
    <div class="m-sheet" role="group" aria-label="添加附件">
      {__PROTOTYPE__ && (
        <div class="m-recent" aria-label="最近的照片（原型示意）">
          {['#c9d6ff', '#ffd7c2', '#d3f0dc', '#e9ddff', '#ffe9a8'].map((c, i) => (
            <button class="m-recent-item" type="button" key={i} style={{ background: `linear-gradient(135deg, ${c}, #8aa0c8)` }} onClick={() => onPick('image')} aria-label="选择这张照片">
              <span class="m-recent-dot" />
            </button>
          ))}
        </div>
      )}
      <div class="m-tiles">
        <button class="m-tile" type="button" onClick={() => onPick('camera')}>
          <MIc n="camera" />
          <span>拍照</span>
        </button>
        <button class="m-tile" type="button" onClick={() => onPick('image')}>
          <MIc n="image" />
          <span>相册</span>
        </button>
        <button class="m-tile" type="button" onClick={() => onPick('any')}>
          <MIc n="clip" />
          <span>文件</span>
        </button>
      </div>
    </div>
  );
}
