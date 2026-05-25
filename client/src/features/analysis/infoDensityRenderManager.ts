import { lsReadBool, lsWriteBool } from '../../shared/storage/localStorageHelpers';

/** 信息密度底色渲染开关 key：为 true 时关闭信息密度/classic 底色（语义叠加层不受影响） */
export const INFO_DENSITY_RENDER_DISABLED_KEY = 'info_radar_disable_info_density_render';

export function getInfoDensityRenderDisabled(): boolean {
    return lsReadBool(INFO_DENSITY_RENDER_DISABLED_KEY, false);
}

export function setInfoDensityRenderDisabled(disabled: boolean): void {
    lsWriteBool(INFO_DENSITY_RENDER_DISABLED_KEY, disabled);
}
