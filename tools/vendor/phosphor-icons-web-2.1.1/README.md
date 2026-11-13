Phosphor Icons（@phosphor-icons/web 2.1.1，MIT 授權，https://phosphoricons.com）的原始樣式表。

建置腳本（tools/build.mjs）會從這兩個檔案挑出專案實際用到的圖示，內嵌到頁面裡；
字型檔本身仍由 unpkg CDN 提供。要升級圖示版本時，替換這兩個檔案並修改 build.mjs 的 PHOSPHOR_VERSION。
