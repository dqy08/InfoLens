import * as d3 from 'd3';

export type ToastType = 'success' | 'error';

export type ToastController = {
    show: (message: string, type?: ToastType, duration?: number) => void;
};

export function createToast(selector: string): ToastController {
    const toast = d3.select(selector);
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;

    const dismiss = () => {
        toast.classed('show', false);
        setTimeout(() => {
            toast.selectAll('*').remove();
            toast.text('').classed('success', false).classed('error', false).classed('dismissible', false);
        }, 300);
    };

    const show = (message: string, type: ToastType = 'success', duration = 3000) => {
        if (dismissTimer) {
            clearTimeout(dismissTimer);
            dismissTimer = null;
        }
        toast.selectAll('*').remove();

        toast
            .classed('success', type === 'success')
            .classed('error', type === 'error')
            .classed('dismissible', type === 'error')
            .classed('show', true);

        if (type === 'error') {
            toast.append('span').attr('class', 'toast-message').text(message);
            toast.append('button')
                .attr('class', 'toast-close')
                .attr('type', 'button')
                .attr('aria-label', 'Close')
                .text('×')
                .on('click', () => dismiss());
        } else {
            toast.text(message);
            dismissTimer = setTimeout(dismiss, duration);
        }
    };

    return { show };
}

