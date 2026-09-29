/**
 * core 公共出口。
 *
 * 契约：这个目录下的所有文件 **不得** 引用 DOM、window、document、any 宿主 API。
 * Taro（小程序）与 React Native 通过各自实现 LayoutProvider / 渲染适配器来消费这里的逻辑。
 */

export * from './model';
export * from './markdown';
export * from './theme';
export * from './pagination';
export * from './gesture';
export * from './flip';
export * from './easing';
export * from './version';
