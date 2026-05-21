# 城市大师漫游 / City Walking Master

一个艺术化的城市街区漫游原型：用画笔风格的 SVG 地图探索历史街区，与街区名人对话。

## 功能

- 6 座城市的著名街区：巴黎蒙马特、纽约格林威治村、伦敦布鲁姆斯伯里、东京浅草、维也纳内城、香港中环
- 手绘风格街区地图，每座城市有独立的色彩与线条设计
- 历史事件与街道对应，可点击地图标记探索
- 简笔画风格名人肖像，可向名人提问并获得回答
- 键盘/点击漫游，ambient 氛围音

## 运行方式

本项目是一个 [Cursor Canvas](https://cursor.com/docs) 应用。

1. 在 Cursor 中打开本仓库
2. 打开 `canvases/city-walking-master.canvas.tsx`
3. 在聊天面板旁打开 Canvas 预览即可交互

## 技术说明

- 单文件 React Canvas（`cursor/canvas` SDK）
- 无外部网络请求，所有数据与 SVG 内嵌在 canvas 文件中
- 使用 Web Audio API 合成 ambient 音效

## 许可

MIT
