import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
    getAuth, 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    GoogleAuthProvider, 
    signInWithPopup, 
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    getDatabase, 
    ref, 
    set, 
    get, 
    child, 
    update, 
    onValue, 
    runTransaction, 
    push 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyCcqtIOZ1E5O--gKxOfKofE0LwQeKPtBzs",
    authDomain: "agenda-16a31.firebaseapp.com",
    databaseURL: "https://agenda-16a31-default-rtdb.firebaseio.com",
    projectId: "agenda-16a31",
    storageBucket: "agenda-16a31.firebasestorage.app",
    messagingSenderId: "865554229500",
    appId: "1:865554229500:web:f786ebd6f0d0781019cf79"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const rtdb = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

export { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signInWithPopup, 
    signOut, 
    onAuthStateChanged,
    ref, 
    set, 
    get, 
    child, 
    update, 
    onValue, 
    runTransaction, 
    push 
}
