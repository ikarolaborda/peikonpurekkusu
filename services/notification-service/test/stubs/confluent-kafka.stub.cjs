// ESM/native module stubbed for unit tests — the tests exercise templating
// and consumer routing logic, not the real Kafka client.
module.exports = {
  KafkaJS: {
    Kafka: class Kafka {
      producer() {
        return {};
      }
      consumer() {
        return {};
      }
    },
  },
};
