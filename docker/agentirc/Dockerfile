FROM python:3.11-slim

WORKDIR /app

# Install agentirc from PyPI
RUN pip install --no-cache-dir agentirc

# Expose IRC port
EXPOSE 6667

# Default command — agentirc provides a CLI entry point
CMD ["agentirc"]
