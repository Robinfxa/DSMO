import { M, type MIconName } from './icons';

export function MIc({ n }: { n: MIconName }) {
  return <i class="ic m-ic" aria-hidden="true" dangerouslySetInnerHTML={{ __html: M[n] }} />;
}
