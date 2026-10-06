/** Semantic analysis 开关：URL 参数 semantic_analysis；仅管理员可用 */
import URLHandler from '../core/URLHandler';
import { AdminManager } from './adminManager';

export function getSemanticAnalysisEnabled(): boolean {
    if (!AdminManager.getInstance().isInAdminMode()) return false;
    const urlVal = URLHandler.parameters['semantic_analysis'] as string | number | boolean | undefined;
    if (urlVal === '1' || urlVal === 'true' || urlVal === 1 || urlVal === true) return true;
    if (urlVal === '0' || urlVal === 'false' || urlVal === 0 || urlVal === false) return false;
    return false;
}

export function setSemanticAnalysisEnabled(enabled: boolean): void {
    if (enabled && !AdminManager.getInstance().isInAdminMode()) return;
    const params = URLHandler.parameters;
    if (enabled) {
        params['semantic_analysis'] = '1';
    } else {
        delete params['semantic_analysis'];
    }
    URLHandler.updateUrl(params, false);
}
