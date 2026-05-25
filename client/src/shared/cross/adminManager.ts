/**
 * 管理员状态管理模块
 */

import { lsGet, lsRemove, lsSet } from '../storage/localStorageHelpers';

const INFORADAR_ADMIN_TOKEN_KEY = 'admin_token';
const ADMIN_MODE_KEY = 'is_admin_mode';

export class AdminManager {
    private static instance: AdminManager | null = null;
    private adminToken: string | null = null;
    private isAdminMode: boolean = false;

    private constructor() {
        // 从localStorage恢复状态
        const savedToken = lsGet(INFORADAR_ADMIN_TOKEN_KEY);
        const savedMode = lsGet(ADMIN_MODE_KEY);
        
        if (savedToken) {
            this.adminToken = savedToken;
        }
        
        if (savedMode === 'true') {
            this.isAdminMode = true;
        }
    }

    public static getInstance(): AdminManager {
        if (!AdminManager.instance) {
            AdminManager.instance = new AdminManager();
        }
        return AdminManager.instance;
    }

    /**
     * 获取当前admin token
     */
    public getAdminToken(): string | null {
        return this.adminToken;
    }

    /**
     * 检查是否处于管理员模式
     */
    public isInAdminMode(): boolean {
        return this.isAdminMode && this.adminToken !== null;
    }

    /**
     * 设置admin token并进入管理员模式
     * 返回后端的 success / message，方便前端直接展示后端文案
     */
    public async setAdminToken(token: string): Promise<{ success: boolean; message?: string }> {
        try {
            // 验证token（调用后端API）
            const response = await fetch('/api/check_admin', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Token': token
                },
                body: JSON.stringify({ token })
            });

            const result = await response.json();
            
            if (result.success) {
                this.adminToken = token;
                this.isAdminMode = true;
                lsSet(INFORADAR_ADMIN_TOKEN_KEY, token);
                lsSet(ADMIN_MODE_KEY, 'true');
                return {
                    success: true,
                    message: result.message
                };
            } else {
                // token无效或管理员功能未启用
                this.clearAdminToken();
                return {
                    success: false,
                    // 不自作主张改写文案，优先使用后端 message
                    message: result && typeof result.message === 'string' ? result.message : undefined
                };
            }
        } catch (error) {
            console.error('验证admin token失败:', error);
            this.clearAdminToken();
            // 网络等异常场景单独返回一条通用错误
            return {
                success: false,
                message: 'Request failed, please try again later.'
            };
        }
    }

    /**
     * 清除admin token并退出管理员模式
     */
    public clearAdminToken(): void {
        this.adminToken = null;
        this.isAdminMode = false;
        lsRemove(INFORADAR_ADMIN_TOKEN_KEY);
        lsRemove(ADMIN_MODE_KEY);
    }

    /**
     * 监听管理员模式状态变化
     */
    private listeners: Array<(isAdmin: boolean) => void> = [];

    public onAdminModeChange(callback: (isAdmin: boolean) => void): void {
        this.listeners.push(callback);
    }

    private notifyListeners(): void {
        const isAdmin = this.isInAdminMode();
        this.listeners.forEach(callback => callback(isAdmin));
    }

    /**
     * 设置admin token并通知监听器
     */
    public async setAdminTokenAndNotify(token: string): Promise<{ success: boolean; message?: string }> {
        const result = await this.setAdminToken(token);
        this.notifyListeners();
        return result;
    }

    /**
     * 清除admin token并通知监听器
     */
    public clearAdminTokenAndNotify(): void {
        this.clearAdminToken();
        this.notifyListeners();
    }
}
