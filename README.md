# Patch YouTube Morphe

Tự động tải + patch YouTube APK bằng APKMirror và Morphe CLI.

## Cách hoạt động

1. Tải `morphe-desktop` (CLI) và `morphe-patches` mới nhất từ GitHub.
2. Lấy danh sách version YouTube tương thích, chọn version mới nhất.
3. Tải APK gốc (**chưa patch**) từ APKMirror.
4. Patch APK bằng Morphe CLI.
5. Upload APK đã patch + MicroG lên GitHub Release.

## Cache APK gốc

APK YouTube chưa patch được lưu cache trong thư mục `downloads/` theo tên:

```
downloads/youtube-<version>-universal.apk
```

- Trước khi tải, script kiểm tra cache theo **version**. Nếu đã có APK của đúng version đó thì **tái sử dụng**, không gọi APKMirror.
- Chỉ tải APK mới khi phát hiện **version mới**.
- File tải dở được ghi ra `*.part` rồi mới đổi tên, nên cache không bao giờ chứa APK hỏng/thiếu. APK nhỏ hơn 1 MB bị coi là lỗi và sẽ được tải lại.
- Trên GitHub Actions, thư mục `downloads/` được giữ lại giữa các lần chạy bằng `actions/cache`.
