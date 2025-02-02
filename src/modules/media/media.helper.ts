export const processResponseBody = (response: Response) => {
  return new ReadableStream({
    start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
            pump();
          })
          .catch((err) => {
            console.error('Stream error:', err);
            controller.error(err);
          });
      };

      pump();
    },
  });
};
