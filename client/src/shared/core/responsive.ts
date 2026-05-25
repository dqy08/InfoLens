/**
 * 响应式设计工具模块
 * 使用 CSS 变量和 matchMedia API 实现单一数据源
 */

import { lsGet, lsRemove, lsSet } from '../storage/localStorageHelpers';

/**
 * 从 CSS 变量获取断点值
 */
const getBreakpointValue = (variableName: string): number => {
  const root = document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(variableName).trim();

  if (!value) {
    throw new Error(`CSS variable ${variableName} is not defined`);
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`CSS variable ${variableName} is not a valid number: ${value}`);
  }

  return parsed;
};

// 延迟初始化，确保 CSS 已加载
let mobileBreakpoint: number | null = null;
let mobileMediaQuery: MediaQueryList | null = null;

/**
 * 获取移动端断点查询对象
 */
const getMobileMediaQuery = (): MediaQueryList => {
  if (mobileMediaQuery === null) {
    if (mobileBreakpoint === null) {
      mobileBreakpoint = getBreakpointValue('--breakpoint-mobile');
    }
    mobileMediaQuery = window.matchMedia(`(max-width: ${mobileBreakpoint}px)`);
  }
  return mobileMediaQuery;
};

/** localStorage + 根节点 `data-force-narrow`，配套 _responsive.scss（宽屏用 :has(.main_frame)） */
export const FORCE_NARROW_STORAGE_KEY = 'info_radar_force_narrow';

/** 本标签设置或跨标签 storage 变化时都会派发（`window` 上） */
export const FORCE_NARROW_CHANGE_EVENT = 'force-narrow-change';

export const getForceNarrowScreen = (): boolean =>
  lsGet(FORCE_NARROW_STORAGE_KEY) === '1';

export const syncForceNarrowAttribute = (): void => {
  const root = document.documentElement;
  if (getForceNarrowScreen()) root.setAttribute('data-force-narrow', '');
  else root.removeAttribute('data-force-narrow');
};

let forceNarrowStorageListenerAttached = false;

/** 在入口最早调用；同步根节点并监听跨标签 storage */
export const initForceNarrowFromStorage = (): void => {
  syncForceNarrowAttribute();
  if (forceNarrowStorageListenerAttached) return;
  forceNarrowStorageListenerAttached = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== FORCE_NARROW_STORAGE_KEY) return;
    syncForceNarrowAttribute();
    window.dispatchEvent(new Event(FORCE_NARROW_CHANGE_EVENT));
    window.dispatchEvent(new Event('resize'));
  });
};

export const setForceNarrowScreen = (enabled: boolean): void => {
  if (enabled) lsSet(FORCE_NARROW_STORAGE_KEY, '1');
  else lsRemove(FORCE_NARROW_STORAGE_KEY);
  syncForceNarrowAttribute();
  window.dispatchEvent(new Event(FORCE_NARROW_CHANGE_EVENT));
  window.dispatchEvent(new Event('resize'));
};

/** 视口处在窄屏断点，或开启强制窄屏（未持久化时仅视口生效，与改动前一致） */
export const isNarrowScreen = (): boolean =>
  getMobileMediaQuery().matches || getForceNarrowScreen();

/**
 * 检测是否为移动端设备（基于设备能力）
 * 移动端：有触屏支持，且没有鼠标或没有悬浮支持
 */
export const isMobileDevice = (): boolean => {
    // 检查是否有触摸支持
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    
    // 检查是否有鼠标（精确指针）
    const hasMouse = window.matchMedia('(pointer: fine)').matches;
    
    // 检查是否支持悬浮（hover）
    const hasHover = window.matchMedia('(hover: hover)').matches;
    
    // 移动端：有触摸支持，且没有鼠标或没有悬浮支持
    return hasTouch && (!hasMouse || !hasHover);
};

/**
 * 获取当前垂直滚动条占用的布局宽度（单位：px）
 * - 传统滚动条模式下：返回大于 0 的数值
 * - overlay 滚动条或无滚动条时：返回 0
 */
export const getVerticalScrollbarWidth = (): number => {
  // window.innerWidth: 包含垂直滚动条宽度
  // document.documentElement.clientWidth: 不包含垂直滚动条宽度
  const width = window.innerWidth - document.documentElement.clientWidth;
  return width > 0 ? width : 0;
};

/**
 * 判断当前是否使用“占用布局宽度”的传统滚动条
 * - true: 滚动条占用布局宽度（非 overlay）
 * - false: 滚动条为 overlay 或当前无滚动条
 */
export const isTraditionalScrollbar = (): boolean => getVerticalScrollbarWidth() > 0;