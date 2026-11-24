/* 開機程式的最後一行（P08）：所有開機模組都已宣告，頁面與彈窗的 HTML、啟動資料都已解析。
 * 不等 DOMContentLoaded（延後程式與內嵌圖片可能還在下載），直接開始畫首屏，見 app/bootstrap.js。 */
AppBoot.start();
