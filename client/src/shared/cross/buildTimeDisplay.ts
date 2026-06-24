import { FRONTEND_BUILD_TIME } from '../buildInfo';

const VALUE_ID = 'frontend_build_time';

function formatBuildTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function initFrontendBuildTimeDisplay(): void {
    const el = document.getElementById(VALUE_ID);
    if (!el) return;
    el.textContent = `Build: ${formatBuildTime(FRONTEND_BUILD_TIME)}`;
}
