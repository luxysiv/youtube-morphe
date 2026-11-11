# Patch YouTube Morphe

Tự động tải + patch YouTube APK bằng APKMirror và Morphe CLI.

Viết bằng **bash thuần** (không cần Node.js/Playwright). Chỉ cần `curl`, `java` 21+, `sed`, `awk`, `grep`.

## Cách hoạt động

1. Tải `morphe-desktop` (CLI) và `morphe-patches` mới nhất từ GitHub.
2. Bỏ qua nếu đúng version patches đã từng release.
3. Lấy danh sách version YouTube tương thích, chọn version mới nhất.
4. Tải APK gốc (**chưa patch**) từ APKMirror bằng `curl`.
5. Patch APK bằng Morphe CLI.
6. Upload APK đã patch + MicroG lên GitHub Release.

## Chạy local

```bash
export GITHUB_TOKEN="<token có quyền repo>"
export GITHUB_REPOSITORY="owner/repo"
bash patch.sh
```

## Cache APK gốc

APK YouTube chưa patch được lưu cache trong thư mục `downloads/` theo tên:

```
downloads/youtube-<version>-universal.apk
```

- Trước khi tải, script kiểm tra cache theo **version**. Nếu đã có APK của đúng version đó thì **tái sử dụng**, không gọi APKMirror.
- Chỉ tải APK mới khi phát hiện **version mới**.
- File tải dở được ghi ra `*.part` rồi mới đổi tên, nên cache không bao giờ chứa APK hỏng/thiếu. APK nhỏ hơn 1 MB bị coi là lỗi và sẽ được tải lại.
- Trên GitHub Actions, thư mục `downloads/` được giữ lại giữa các lần chạy bằng `actions/cache`.

## GitHub Actions

Workflow nằm ở `.github/workflows/patch.yml` và chạy `bash patch.sh`.
