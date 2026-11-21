// The DSMO QQ group: in 设置 › 关于 and under 启动引擎 (setup/gate.tsx).
import { native } from './bridge/native';

export const QQ_GROUP = 'https://qm.qq.com/q/21annsvqgw';
export const joinGroup = () => void native.openExternal(QQ_GROUP);
