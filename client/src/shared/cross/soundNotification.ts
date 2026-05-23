/**
 * 声音通知工具
 * 使用 Web Audio API 播放提示音，无需音频文件
 */

/**
 * 播放分析完成提示音
 * 使用 Web Audio API 生成一个简短悦耳的提示音，表示分析任务已完成
 */
export function playAnalysisCompleteSound(): void {
    try {
        // 创建一个新的 AudioContext（每次调用时创建，避免浏览器自动暂停）
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        // 创建振荡器和增益节点
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        // 连接节点
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // 设置音调：先高后低，形成"完成"的感觉（类似 Cursor IDE 的提示音）
        oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
        oscillator.frequency.setValueAtTime(900, audioContext.currentTime + 0.15);
        
        // 设置音色（sine 更柔和）
        oscillator.type = 'sine';
        
        // 设置音量：淡入淡出，避免突兀
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
        
        // 播放（总时长约 300ms）
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.3);
        
        // 清理资源
        oscillator.onended = () => {
            audioContext.close();
        };
    } catch (error) {
        // 静默失败，不影响主要功能
        // 某些浏览器可能不支持 Web Audio API 或需要用户交互后才能播放
        console.debug('无法播放提示音:', error);
    }
}

