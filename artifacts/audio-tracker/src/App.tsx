import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AudioTracker from "@/pages/AudioTracker";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AudioTracker />
    </QueryClientProvider>
  );
}

export default App;
