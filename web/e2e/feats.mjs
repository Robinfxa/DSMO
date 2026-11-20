// The sidebar's feature rows sit behind one 「功能」 row (ui/featFold.ts), folded on every launch.
// Tests that open a feature from the sidebar unfold it first.
export async function openFeats(page) {
  for (const sel of ['.m-feat-fold[aria-expanded="false"]', '.feat-fold[aria-expanded="false"]'])
    if (await page.isVisible(sel)) {
      await page.click(sel);
      await page.waitForTimeout(250);
    }
}
