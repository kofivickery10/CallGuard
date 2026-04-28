import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';

interface FileDropzoneProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export function FileDropzone({ onFileSelected, disabled }: FileDropzoneProps) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles[0]) {
        onFileSelected(acceptedFiles[0]);
      }
    },
    [onFileSelected]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'audio/mpeg': ['.mp3'],
      'audio/wav': ['.wav'],
      'audio/x-m4a': ['.m4a'],
      'audio/mp4': ['.m4a'],
    },
    maxFiles: 1,
    disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={`border-2 border-dashed rounded-xl py-[60px] px-10 text-center cursor-pointer transition-all bg-white ${
        isDragActive
          ? 'border-primary bg-page'
          : disabled
            ? 'border-border bg-page cursor-not-allowed opacity-60'
            : 'border-[#c8d8c8] hover:border-primary hover:bg-page'
      }`}
    >
      <input {...getInputProps()} />
      <div className="w-12 h-12 bg-primary-light rounded-xl flex items-center justify-center mx-auto mb-4">
        <svg viewBox="0 0 24 24" className="w-6 h-6 stroke-primary" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      {isDragActive ? (
        <div className="text-[16px] font-semibold text-text-primary">Drop audio files here</div>
      ) : (
        <>
          <div className="text-[16px] font-semibold text-text-primary mb-1.5">
            Drop audio files here or click to upload
          </div>
          <div className="text-table-cell text-text-muted">
            Supports MP3, WAV, M4A — up to 100MB per file
          </div>
          <div className="mt-5">
            <span className="inline-block px-[18px] py-[9px] bg-primary text-white rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors">
              Select Files
            </span>
          </div>
        </>
      )}
    </div>
  );
}
