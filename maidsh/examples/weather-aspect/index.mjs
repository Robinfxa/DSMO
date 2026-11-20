// 第三方接入陪伴套件的最小例子（CONTRACT.md §4）。任何 DSH 插件照这样就能成为一个「面」：
// 装了总控（服务 companion）就登记，没装就什么都不做；总控装上、卸载都不用重启。

export const name = 'example-weather-aspect';

export function apply(ctx) {
  let mentioned = false;
  ctx.inject(['companion'], (sub) => {
    sub.effect(() =>
      sub.companion.register({
        id: 'weather',
        title: '天气感知',
        version: 1,
        // 每轮想从对话里得到什么：总控会把它并进那一次分析调用
        analysis: {
          schema: { type: 'object', properties: { mentioned: { type: 'boolean' } } },
          instructions: '用户这一轮是否提到了天气',
        },
        // result 只含本面的键；读不出时是 null。turn.feeling 是共用感受
        onAnalysis(result) {
          mentioned = result?.mentioned === true;
        },
        prompt: { order: 500, maxChars: 60, text: () => (mentioned ? '对方刚提到天气，可以顺口关心一句。' : '') },
        state: () => ({ mentioned }),
      }),
    );
  });
}
