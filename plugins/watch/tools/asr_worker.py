"""One cancellable offline transcriber per Watch service (its jobs run serially)."""
import multiprocessing
import sys
import time
import traceback

from common import WatchError


def serve(connection, model_path):
    from transcribe import load_model, recognize
    failure = b"load"
    try:
        model = load_model(model_path)
        failure = b"recognize"
        while True:
            audio, output, language = connection.recv()
            recognize(model, audio, output, language)
            connection.send_bytes(b"ok")
    except (EOFError, BrokenPipeError):
        pass
    except Exception as error:
        frames = traceback.extract_tb(error.__traceback__)
        location = frames[-1].name if frames else "serve"
        print(f"Watch ASR: {type(error).__name__} in {location}", file=sys.stderr, flush=True)
        connection.send_bytes(failure)
    finally:
        connection.close()


class TranscriptionWorker:
    def __init__(self):
        self.process = None
        self.connection = None
        self.model = None

    def close(self):
        if self.connection is not None:
            self.connection.close()
        if self.process is not None:
            if self.process.is_alive():
                self.process.kill()
            self.process.join(5)
            self.process.close()
        self.process = self.connection = self.model = None

    def transcribe(self, model, audio, output, language, runner):
        runner.check()
        if self.process is None or not self.process.is_alive() or model != self.model:
            self.close()
            ctx = multiprocessing.get_context("spawn")
            parent, child = ctx.Pipe()
            proc = ctx.Process(target=serve, args=(child, model), daemon=True)
            try:
                proc.start()
            except BaseException:
                parent.close()
                raise
            finally:
                child.close()
            self.process, self.connection, self.model = proc, parent, model
        try:
            self.connection.send((audio, output, language))
            deadline = time.monotonic() + 600
            while not self.connection.poll(0.1):
                runner.check()
                if not self.process.is_alive():
                    raise WatchError("转写进程已退出")
                if time.monotonic() >= deadline:
                    raise WatchError("本地转写超过 600 秒")
            runner.check()
            response = self.connection.recv_bytes(16)
            if response == b"load":
                raise WatchError("本地语音模型加载失败")
            if response != b"ok":
                raise WatchError("本地语音识别失败")
        except (EOFError, BrokenPipeError, ConnectionResetError) as error:
            self.close()
            raise WatchError("转写进程连接已断开") from error
        except BaseException:
            self.close()
            raise
