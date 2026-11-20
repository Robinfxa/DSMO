# maidsh-expression · MaiDSH 表达

TA 会慢慢学会你的说话方式：你的口头禅、句式，还有只在你们之间才懂的「黑话」。越熟，TA 说话越有你们俩的味道。可以单独用。

- **只学你的话**：每轮从你这一轮的话里学 0–2 条有辨识度的说法（「被夸的时候会说『哼，那还用说』」）和黑话（「小狗勾 = 撒娇时的自称」），AI 自己说的不学，普通措辞不学。
- **跟着关系走**：好感度「一般」及以下只做到听得懂你的黑话，不模仿；「亲近」「喜欢」偶尔借用一两句；「暧昧」用得更多，也会更俏皮。TA 心情低落时不用俏皮的说法。和人设冲突时以人设为准。
- **会淡**：一种说法三周不出现，分量就淡一半；你受用的会更常用，不受用的少用。
- 装了 `maidsh-core` 时，学习并进总控那一次分析，**每轮不多调模型**；还能从你指定的对话、导入的聊天记录里批量学。
- 数据在 `<DSH_HOME>/storages/maidsh-expression/expression.json`。服务 `companionExpression`；接口 `GET /api/maidsh-expression/list`、`POST /api/maidsh-expression/mutate`（只接本机同源请求）。

配置（都可选）：`provider` + `model`（成对给）、`dataDir`。

设计思路参考 MaiBot（麦麦）的表达方式学习和黑话学习，代码从头写，与 MaiBot 官方无关。MIT。
