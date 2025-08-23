import React, { useState } from 'react';
import axios from 'axios';

const App = () => {
  const [botId, setBotId] = useState('');
  const [specFile, setSpecFile] = useState<File | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSpecFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!specFile || !botId) {
      alert('Please provide bot ID and spec file.');
      return;
    }

    const formData = new FormData();
    formData.append('spec', specFile);

    try {
      // Не нужно явно устанавливать 'Content-Type', браузер сделает это сам.
      const response = await axios.post('http://localhost:3000/spec', formData, {
        headers: {
          'x-bot-id': botId,  // передаем x-bot-id
        },
        withCredentials: true,  // разрешаем кросс-доменные запросы с куки
      });

      console.log(response.data);
      alert(`Spec uploaded successfully! Version: ${response.data.version}`);
    } catch (error) {
      console.error('Error uploading spec:', error);
      alert('Failed to upload spec');
    }
  };

  return (
    <div className="App">
      <h1>Upload Bot Specification</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Enter Bot ID"
          value={botId}
          onChange={(e) => setBotId(e.target.value)}
        />
        <input type="file" onChange={handleFileChange} />
        <button type="submit">Upload Spec</button>
      </form>
    </div>
  );
};

export default App;
