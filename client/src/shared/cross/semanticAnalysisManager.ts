/** Semantic analysis 开关：仅由 URL 参数 semantic_analysis 决定 */
import URLHandler from '../core/URLHandler';

export function getSemanticAnalysisEnabled(): boolean {
    const urlVal = URLHandler.parameters['semantic_analysis'] as string | number | boolean | undefined;
    if (urlVal === '1' || urlVal === 'true' || urlVal === 1 || urlVal === true) return true;
    if (urlVal === '0' || urlVal === 'false' || urlVal === 0 || urlVal === false) return false;
    return false;
}

export function setSemanticAnalysisEnabled(enabled: boolean): void {
    const params = URLHandler.parameters;
    if (enabled) {
        params['semantic_analysis'] = '1';
    } else {
        delete params['semantic_analysis'];
    }
    URLHandler.updateUrl(params, false);
}
