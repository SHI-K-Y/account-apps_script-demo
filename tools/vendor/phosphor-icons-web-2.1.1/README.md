Phosphor Icons（@phosphor-icons/web 2.1.1，MIT 授權，https://phosphoricons.com）的原始樣式表。

建置腳本（tools/build.mjs）會從這兩個檔案挑出專案實際用到的圖示，內嵌到頁面裡；
字型檔取自 npm 套件 @phosphor-icons/web@2.1.1（devDependencies，版本固定），用 subset-font 裁成只含用到的字元後
以 data URI 內嵌，頁面不再向 unpkg 下載字型。只有遇到子集以外的圖示時，前端才會向 unpkg 補載完整樣式表。
要升級圖示版本時，替換這兩個檔案、更新 package.json 裡 @phosphor-icons/web 的版本，並修改 build.mjs 的 PHOSPHOR_VERSION
（三者必須是同一個版本，字元編號才對得上）。
