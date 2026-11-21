// Canned agent behaviour for the mock engine. Each script is a list of model
// steps; a step may end with one tool call, which the engine runs (asking for
// approval when the tool is risky and the session isn't in full access).

export interface ScriptTool {
  name: string;
  args: Record<string, unknown>;
  result: string;
  risky?: boolean;
  reason?: string;
  zhReason?: string;
  deniedText?: string;
  ms?: number;
  /** Starts a background job with this label instead of returning output. */
  job?: string;
  /** Files declared by a `present` call (deliverables/presented). */
  presents?: { path: string; description?: string }[];
}
export interface ScriptStep {
  /** Ask the user (ask_user_question): the next step's text gets `{answer}` filled in. */
  ask?: { id: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[];
  reasoning?: string;
  text?: string;
  tool?: ScriptTool;
  todos?: { content: string; status: string; activeForm?: string }[];
}
export interface Script {
  steps: ScriptStep[];
}

const think = (effort: string, text: string) => (effort === 'off' ? undefined : text);

export function pickScript(prompt: string, ctx: { effort: string; permission: string }): Script {
  const p = prompt.trim();
  const has = (...words: string[]) => words.some((w) => p.toLowerCase().includes(w));
  // 账号管理 › 真实小额测试: a model that answers what it's asked
  if (p.includes('连通性测试')) return { steps: [{ text: 'OK' }] };

  if (has('测试', 'test', '修复', 'bug', '修一下')) {
    return {
      steps: [
        {
          reasoning: think(ctx.effort, '先看看相关代码在哪，再决定怎么改。改完需要跑一下测试确认。'),
          text: '我先看一下相关文件。',
          todos: [
            { content: '找到相关代码', status: 'in_progress', activeForm: '正在查找相关代码' },
            { content: '修改并补测试', status: 'pending' },
            { content: '运行测试', status: 'pending' },
          ],
          tool: { name: 'read', args: { path: 'src/app.ts' }, result: "export function hello(name: string) {\n  return `你好，${name}`;\n}\n", ms: 500 },
        },
        {
          text: '找到了，改一下并补一个测试。',
          todos: [
            { content: '找到相关代码', status: 'completed' },
            { content: '修改并补测试', status: 'in_progress', activeForm: '正在修改代码' },
            { content: '运行测试', status: 'pending' },
          ],
          tool: { name: 'edit', args: { path: 'src/app.ts', old: '`你好，${name}`', new: '`你好，${name.trim()}`' }, result: 'Edited src/app.ts (1 change)', ms: 600 },
        },
        {
          todos: [
            { content: '找到相关代码', status: 'completed' },
            { content: '修改并补测试', status: 'completed' },
            { content: '运行测试', status: 'in_progress', activeForm: '正在运行测试' },
          ],
          tool: {
            name: 'bash',
            args: { command: 'npm test -- src/app.test.ts', description: '运行相关测试', sandbox_permissions: 'danger-full-access', justification: '测试需要联网安装依赖' },
            result: ' ✓ src/app.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n',
            risky: true,
            reason: 'escalate sandbox to danger-full-access: 测试需要联网安装依赖',
            zhReason: '允许本次操作使用完全访问权限：测试需要联网安装依赖',
            deniedText: '好的，测试没有跑。代码已经改好了，你可以稍后自己运行 `npm test` 确认。',
            ms: 1400,
          },
        },
        {
          todos: [
            { content: '找到相关代码', status: 'completed' },
            { content: '修改并补测试', status: 'completed' },
            { content: '运行测试', status: 'completed' },
          ],
          text: '改好了：输入的名字会先去掉首尾空格；新加的测试覆盖了带空格的情况，两项测试都通过了。',
        },
      ],
    };
  }

  if (has('表', 'csv', '汇总', '花销', '数据')) {
    return {
      steps: [
        {
          reasoning: think(ctx.effort, '用户想按类别汇总账单。先读 CSV，再用脚本算出每类的合计。'),
          tool: { name: 'read', args: { path: '账单-10月.csv' }, result: '日期,类别,金额\n10-01,餐饮,36.5\n10-01,交通,4\n10-02,餐饮,52\n10-03,购物,199\n10-05,餐饮,41.2', ms: 400 },
        },
        {
          tool: {
            name: 'bash',
            args: { command: 'python3 make_sheet.py 账单-10月.csv', description: '按类别汇总' },
            result: '交通\t4.00\n购物\t199.00\n餐饮\t129.70\n',
            ms: 900,
          },
        },
        {
          tool: { name: 'present', args: { files: [{ path: '/home/user/workspace/汇总-10月.csv', description: '按类别汇总' }] }, result: 'Presented /home/user/workspace/汇总-10月.csv', ms: 300, presents: [{ path: '/home/user/workspace/汇总-10月.csv', description: '按类别汇总' }] },
        },
        { text: '汇总好了：\n\n| 类别 | 金额 |\n|---|---|\n| 餐饮 | 129.70 |\n| 购物 | 199.00 |\n| 交通 | 4.00 |\n\n本月合计 **332.70**，餐饮占了大约四成。' },
      ],
    };
  }

  if (has('后台', '服务', 'server', 'dev', '启动')) {
    return {
      steps: [
        {
          reasoning: think(ctx.effort, '要长时间运行的进程，放到后台任务里跑。'),
          tool: { name: 'bash', args: { command: 'npm run dev', description: '启动开发服务器', run_in_background: true }, result: '', job: 'npm run dev', ms: 500 },
        },
        { text: '开发服务器已经在后台启动了。可以在「后台任务」里看输出，或者随时停掉。' },
      ],
    };
  }

  if (has('问我', '帮我选', '帮我挑')) {
    return {
      steps: [
        {
          reasoning: think(ctx.effort, '用户的偏好不清楚，先问一下再写。'),
          ask: [{ id: 'style', question: '你想要哪种风格？', options: [{ label: '简洁', description: '三五句话' }, { label: '详细', description: '分点展开' }, { label: '幽默' }] }],
        },
        { text: '好的，按「{answer}」的风格来：这是原型里的模拟回答，接上引擎后这里会是真正的内容。' },
      ],
    };
  }

  if (has('删除', 'rm ', '清空')) {
    return {
      steps: [
        {
          reasoning: think(ctx.effort, '删除是不可恢复的操作，需要用户确认。'),
          tool: {
            name: 'bash',
            args: { command: 'rm -rf build/', description: '删除构建产物', sandbox_permissions: 'danger-full-access', justification: '删除工作区外的缓存' },
            result: '',
            risky: true,
            reason: 'escalate sandbox to danger-full-access: 删除构建目录',
            zhReason: '允许本次操作使用完全访问权限：删除 build/ 目录',
            ms: 500,
          },
        },
        { text: '已经删掉 `build/` 目录。' },
      ],
    };
  }

  const reply = generic(p);
  return { steps: [{ reasoning: think(ctx.effort, reply.reasoning), text: reply.text }] };
}

function generic(p: string) {
  if (/^(你好|hi|hello|嗨)/i.test(p)) return { reasoning: '用户在打招呼，简单回应并说明能做什么。', text: '你好！我可以回答问题、写东西，也可以在工作区里读写文件、运行命令。有什么想做的？' };
  if (p.length < 12)
    return { reasoning: '问题很短，直接回答。', text: `收到：「${p}」。这是原型里的模拟回复——接上真实引擎后，这里会是模型的回答。` };
  return {
    reasoning: '先理解用户想要什么，再分点给出清楚的回答。',
    text: `好的，关于「${p.slice(0, 24)}${p.length > 24 ? '…' : ''}」，我的建议是：\n\n1. 先把目标说清楚：要解决什么、做到什么程度算完成。\n2. 拆成几步，每一步都能单独验证。\n3. 做完一步就检查一步，有问题及时调整。\n\n这是原型里的模拟回复；试试输入「修复一个 bug 并补测试」「把花销做成表」「在后台启动服务」，可以看到工具调用、授权和待办。`,
  };
}
