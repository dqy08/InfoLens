/** Token 染色方式：density=按信息密度(bits/Byte)，classic=按 token 信息量(bits)。未写入 localStorage 时默认为 classic */
import { lsGet, lsSet } from '../storage/localStorageHelpers';

export type TokenRenderStyle = 'density' | 'classic';

const KEY = 'info_radar_token_render_style';

export function getTokenRenderStyle(): TokenRenderStyle {
    const v = lsGet(KEY);
    // 仅当显式存为 density 时用密度；其余（含未设置、classic、旧值）均为 classic
    return (v === 'density' ? 'density' : 'classic') as TokenRenderStyle;
}

export function setTokenRenderStyle(v: TokenRenderStyle): void {
    lsSet(KEY, v);
}
