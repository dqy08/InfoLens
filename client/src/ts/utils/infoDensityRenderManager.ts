/** 信息密度底色渲染开关：为 true 时关闭信息密度/classic 底色（语义叠加层不受影响） */
const KEY = 'info_radar_disable_info_density_render';

export function getInfoDensityRenderDisabled(): boolean {
    const v = localStorage.getItem(KEY);
    return v === 'true';
}

export function setInfoDensityRenderDisabled(disabled: boolean): void {
    localStorage.setItem(KEY, disabled ? 'true' : 'false');
}
