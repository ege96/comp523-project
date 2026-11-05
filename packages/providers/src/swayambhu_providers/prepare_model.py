"""Rewrite a downloaded ONNX model so its weights sit in a separate file next to the graph.

Run once at image build time (see the Dockerfiles' model stage):

    python prepare_model.py /opt/models/intfloat/multilingual-e5-small

ONNX Runtime memory-maps weights stored that way instead of copying them into process
memory. On CloudApps this took e5-small from 833 MiB of process memory with a 1,144 MiB
load spike to about 400 MiB with no spike. The mapped pages are file cache, which the
kernel can drop and re-read under memory pressure. The graph is optimised as it is saved
(ONNX Runtime's portable "extended" level), so pods also skip that step at startup.
"""

import shutil
import sys
import tempfile
from pathlib import Path

import onnxruntime as ort  # type: ignore[import-untyped]

DATA_FILE = "model.onnx.data"


def externalize(model_dir: Path) -> None:
    source = model_dir / "onnx" / "model.onnx"
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "model.onnx"
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
        options.optimized_model_filepath = str(out)
        options.add_session_config_entry(
            "session.optimized_model_external_initializers_file_name", DATA_FILE
        )
        options.add_session_config_entry(
            "session.optimized_model_external_initializers_min_size_in_bytes", "1024"
        )
        ort.InferenceSession(str(source), options, providers=["CPUExecutionProvider"])
        shutil.move(out, source)
        data = Path(tmp) / DATA_FILE
        if data.exists():  # absent only when every weight is under the size threshold
            shutil.move(data, source.parent / DATA_FILE)


if __name__ == "__main__":
    externalize(Path(sys.argv[1]))
