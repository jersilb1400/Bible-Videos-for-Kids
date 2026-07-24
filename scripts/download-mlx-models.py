"""Download MLX video generation models from HuggingFace Hub."""
import os
import sys
from huggingface_hub import snapshot_download

MODELS = {
    "wan22-ti2v-5b-q8": "Anes1032/Wan2.2-TI2V-5B-mlx-q8",
    # "longcat-avatar-q4": "mlx-community/LongCat-Video-Avatar-1.5-q4-dmd",  # later
}

project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
models_dir = os.path.join(project_root, "models")
os.makedirs(models_dir, exist_ok=True)

for local_name, repo_id in MODELS.items():
    local_path = os.path.join(models_dir, local_name)
    print(f"\n{'='*60}")
    print(f"Downloading: {repo_id}")
    print(f"Target: {local_path}")
    print(f"{'='*60}")

    path = snapshot_download(
        repo_id=repo_id,
        local_dir=local_path,
        local_dir_use_symlinks=False,
    )
    print(f"\nDownload complete: {path}")
    print("Files:")
    for root, dirs, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            size_mb = os.path.getsize(fp) / 1024 / 1024
            rel = os.path.relpath(fp, path)
            print(f"  {rel} ({size_mb:.1f} MB)")

print("\nAll downloads complete.")
