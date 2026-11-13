const ImageOptimizer = {
  compressCardImage: function(file) {
    return this._compress(file, 160, 100, 0.78, false);
  },
  compressBankLogo: function(file) {
    return this._compress(file, 64, 64, 0.82, true);
  },
  _compress: function(file, targetW, targetH, quality, isSquare) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        return reject(new Error('請選擇有效的圖片檔案'));
      }
      const reader = new FileReader();
      reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, targetW, targetH);

            const srcRatio = img.width / img.height;
            const dstRatio = targetW / targetH;
            let sx = 0, sy = 0, sw = img.width, sh = img.height;

            if (srcRatio > dstRatio) {
              sw = img.height * dstRatio;
              sx = (img.width - sw) / 2;
            } else {
              sh = img.width / dstRatio;
              sy = (img.height - sh) / 2;
            }

            if (isSquare) {
              ctx.save();
              ctx.beginPath();
              ctx.arc(targetW / 2, targetH / 2, targetW / 2, 0, Math.PI * 2);
              ctx.closePath();
              ctx.clip();
            }

            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
            if (isSquare) ctx.restore();

            let dataUrl = canvas.toDataURL('image/webp', quality);
            if (!dataUrl || dataUrl.indexOf('data:image/webp') !== 0) {
              dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            if (dataUrl && dataUrl.length > 6000) {
              const smallCanvas = document.createElement('canvas');
              smallCanvas.width = Math.round(targetW * 0.75);
              smallCanvas.height = Math.round(targetH * 0.75);
              const sCtx = smallCanvas.getContext('2d');
              sCtx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
              dataUrl = smallCanvas.toDataURL('image/webp', 0.65);
              if (!dataUrl || dataUrl.indexOf('data:image/webp') !== 0) {
                dataUrl = smallCanvas.toDataURL('image/jpeg', 0.65);
              }
            }
            resolve(dataUrl);
          } catch (err) {
            reject(err);
          }
        };
        img.onerror = function() { reject(new Error('圖片讀取失敗')); };
        img.src = e.target.result;
      };
      reader.onerror = function() { reject(new Error('檔案讀取失敗')); };
      reader.readAsDataURL(file);
    });
  }
};
