# System Architecture

## High-level flow

```text
User
  |
  v
Frontend
  |
  v
Backend API
  |
  +------------------> Database
  |
  v
Machine Learning Model
  |
  v
Prediction / Result
  |
  v
Frontend
```

## Components

### Frontend
Handles user interaction, input collection, and display of results.

### Backend API
Receives requests, validates input, and coordinates application logic.

### Machine Learning Model
Processes the input data and generates a prediction.

### Database
Stores application data such as users, submissions, or prediction history.
